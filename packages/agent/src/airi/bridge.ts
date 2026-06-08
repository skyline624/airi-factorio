import type { PlayerEventMessage } from '../parser'
import type { AiriConfig } from '../types'

import { randomUUID } from 'node:crypto'

import { useLogg } from '@guiiai/logg'
import { Client, ContextUpdateStrategy } from '@proj-airi/server-sdk'

const logger = useLogg('airi-bridge').useGlobalConfig()

/**
 * Shape of a `spark:command` payload (the general's order). Mirrors the minecraft
 * service's bridge. We only read what we need to turn it into an instruction.
 */
interface SparkCommandData {
  commandId: string
  intent: string
  interrupt: 'force' | 'soft' | false
  priority: string
  guidance?: {
    options?: Array<{ label?: string, steps?: string[] }>
  }
}

export interface AiriBridgeOptions {
  /**
   * Called when the general issues a `spark:command`. The text is the human-readable
   * instruction; the agent should treat it exactly like a chat message from its master.
   */
  onCommand: (text: string, meta: { commandId: string, intent: string }) => void | Promise<void>
}

/**
 * Bridges our Factorio agent to the AIRI "general" (the desktop VTuber brain) over the
 * `@proj-airi/server-sdk` WebSocket protocol.
 *
 * - Service -> AIRI: `spark:notify` (urgent alerts) + `context:update` (passive status).
 * - AIRI -> Service: `spark:command` (orders) routed back through `onCommand`, acked via `spark:emit`.
 */
export class AiriBridge {
  constructor(
    private readonly client: Client,
    private readonly options: AiriBridgeOptions,
  ) {}

  init(): void {
    const onSparkCommand = (event: { data: SparkCommandData }): void => {
      const cmd = event.data
      logger.withFields({ intent: cmd.intent, commandId: cmd.commandId, priority: cmd.priority }).log('Received spark:command from general')

      // Acknowledge receipt so the general knows the order landed.
      this.sendEmit(cmd.commandId, 'queued', 'Command received by Factorio agent')

      const text = extractCommandText(cmd)
      Promise.resolve(this.options.onCommand(text, { commandId: cmd.commandId, intent: cmd.intent }))
        .then(() => this.sendEmit(cmd.commandId, 'done'))
        .catch((e: unknown) => {
          logger.withFields({ error: e instanceof Error ? e.message : String(e) }).error('Failed to handle spark:command')
          this.sendEmit(cmd.commandId, 'dropped', 'Agent failed to execute command')
        })
    }

    const onContextUpdate = (event: { data: { lane?: string, text: string } }): void => {
      logger.withFields({ lane: event.data.lane, preview: event.data.text?.slice(0, 80) }).log('Received context:update from AIRI')
    }

    this.client.onEvent('spark:command', onSparkCommand as Parameters<typeof this.client.onEvent<'spark:command'>>[1])
    this.client.onEvent('context:update', onContextUpdate as Parameters<typeof this.client.onEvent<'context:update'>>[1])
    logger.log('AiriBridge initialized — listening for spark:command and context:update')
  }

  /** Urgent alert to the general (drives a fresh decision on the AIRI side). */
  sendNotify(headline: string, note?: string, urgency: 'immediate' | 'soon' | 'later' = 'soon'): void {
    this.client.send({
      type: 'spark:notify',
      data: {
        id: randomUUID(),
        eventId: randomUUID(),
        kind: 'ping',
        urgency,
        headline,
        note,
        destinations: ['proj-airi:stage-*'],
      },
    } as Parameters<typeof this.client.send>[0])
  }

  /** Passive status push (history-only on the AIRI side, never wakes the brain). */
  sendContextUpdate(text: string, hints?: string[], lane = 'factorio:status'): void {
    this.client.send({
      type: 'context:update',
      data: {
        id: randomUUID(),
        contextId: randomUUID(),
        lane,
        text,
        hints,
        strategy: ContextUpdateStrategy.AppendSelf,
      },
    } as Parameters<typeof this.client.send>[0])
  }

  /** Lifecycle ack for a received command. */
  sendEmit(eventId: string, state: 'queued' | 'working' | 'done' | 'dropped', note?: string): void {
    this.client.send({
      type: 'spark:emit',
      data: { id: randomUUID(), eventId, state, note },
    } as Parameters<typeof this.client.send>[0])
  }

  /**
   * Forward a player `[EVENT]` to the general. Combat-critical events become urgent
   * `spark:notify` (so the general reacts); informational ones become `context:update`.
   */
  notifyEvent(message: PlayerEventMessage): void {
    const f = message.fields
    switch (message.eventType) {
      case 'died':
        this.sendNotify(`The Factorio bot died (cause=${f.cause ?? 'unknown'})`, undefined, 'immediate')
        break
      case 'low_health':
        this.sendNotify(`Bot at low health (ratio ${f.ratio ?? '?'})`, 'It may need to flee or fight back.', 'immediate')
        break
      case 'damaged':
        this.sendNotify(`Bot taking damage from ${f.cause ?? 'unknown'}`, `health ${f.health ?? '?'}/${f.max_health ?? '?'}`, 'immediate')
        break
      case 'enemies_spotted':
        this.sendNotify(`${f.count ?? '?'} enemies near the bot`, `nearest ${f.nearest ?? '?'} at ${f.distance ?? '?'}m`, 'soon')
        break
      case 'structure_lost':
        this.sendNotify(`${f.count ?? '?'} of the bot's structure(s) destroyed`, undefined, 'soon')
        break
      case 'enemies_cleared':
        this.sendContextUpdate('No more enemies near the bot.')
        break
      case 'attack_ended':
        this.sendContextUpdate('The attack on the bot has ended.')
        break
      case 'health_recovered':
        this.sendContextUpdate(`Bot health recovered (ratio ${f.ratio ?? '?'}).`)
        break
      default:
        this.sendContextUpdate(`${message.eventType} ${message.raw}`)
    }
  }
}

function extractCommandText(cmd: SparkCommandData): string {
  const first = cmd.guidance?.options?.[0]
  const label = first?.label?.trim()
  if (label) {
    return label
  }
  const steps = first?.steps ?? []
  if (steps.length > 0) {
    return steps.join(' / ')
  }
  return `${cmd.intent} command received`
}

/**
 * Create and start the AIRI bridge. Returns null when disabled. Never blocks the agent:
 * the client reconnects with backoff, so a not-yet-running AIRI hub is fine.
 */
export async function startAiriBridge(
  config: AiriConfig,
  onCommand: AiriBridgeOptions['onCommand'],
): Promise<AiriBridge | null> {
  if (!config.enabled) {
    logger.log('AIRI bridge disabled (set AIRI_ENABLED=true to connect to the general).')
    return null
  }

  logger.withFields({ url: config.url, name: config.name }).log('Connecting to AIRI general…')

  const client = new Client({
    name: config.name,
    url: config.url,
    token: config.token || undefined,
    possibleEvents: ['spark:command', 'context:update', 'module:announced'],
    autoConnect: false,
    // A single LLM turn (kimi with thinking) can block the Node event loop for many
    // seconds, during which the heartbeat ping can't fire and the default 30s read
    // timeout would tear down the connection — losing any spark:command that lands
    // mid-turn. Widen the tolerance (same rationale as the AIRI minecraft service).
    heartbeat: { readTimeout: 120_000, pingInterval: 20_000 },
    onReady: () => logger.log('AIRI bridge READY — connected to the general'),
    onError: (e: unknown) => logger.withFields({ error: e instanceof Error ? e.message : String(e) }).warn('AIRI connection error (will retry)'),
    onClose: () => logger.warn('AIRI connection closed (will retry)'),
  })

  const bridge = new AiriBridge(client, { onCommand })
  bridge.init()

  // Connect in the background. The client retries with backoff (autoReconnect), so a
  // not-yet-running AIRI hub must never block the agent — do not await this.
  void client.connect().catch((e: unknown) => {
    logger.withFields({ error: e instanceof Error ? e.message : String(e) }).warn('AIRI initial connect failed (will keep retrying)')
  })

  return bridge
}

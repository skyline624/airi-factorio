import type { MessageHandler } from './llm/message-handler'
import type { LLMMessage } from './parser'

import { useLogg } from '@guiiai/logg'

const logger = useLogg('autonomous').useGlobalConfig()

/** A batch of operations shouldn't realistically take longer than this before we re-assess. */
const SETTLE_TIMEOUT_MS = 180_000

export interface AutonomousLoopDeps {
  /** Message handler created WITH the autonomous system prompt. */
  handler: MessageHandler
  /** Execute a batch of operation commands in-game (via RCON `/c ...`). */
  execute: (commands: string[]) => Promise<void>
  /** Say a line in the in-game chat (visible to spectators). */
  say: (message: string) => Promise<void>
  /** The high-level objective to pursue. */
  goal: string
  /** Delay between turns (ms). */
  tickDelayMs: number
}

export interface AutonomousController {
  /** Fed by the stdout reader when the current batch settles. */
  onSettled: (result: 'completed' | 'error', detail?: string) => void
  /** Fed when a perception [EVENT] arrives (survival situation). */
  onPerception: (text: string) => void
  /** Fed when a human types in chat (a redirection to honor). */
  onChat: (username: string, message: string) => void
  /** Stop the loop. */
  stop: () => void
}

interface SettleResult { result: 'completed' | 'error' | 'timeout' | 'stopped', detail?: string }

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Drives fully autonomous Factorio play: a perceive → decide (LLM) → act → observe loop.
 *
 * The loop issues operation commands then *awaits* the in-game settle signal
 * (`[MOD] All operations completed` or `[MOD] Error`), which the stdout reader forwards
 * via `onSettled`. Perception alerts and human chat arrive via `onPerception`/`onChat`
 * and are surfaced to the model on the next turn.
 */
export function startAutonomousLoop(deps: AutonomousLoopDeps): AutonomousController {
  let running = true
  let tick = 0
  let lastResult = 'You are just starting out. Nothing has been done yet — assess your inventory and surroundings, then take your first concrete step.'
  const inbox: string[] = []
  let settle: ((value: SettleResult) => void) | null = null

  function resolveSettle(value: SettleResult) {
    if (settle) {
      const fn = settle
      settle = null
      fn(value)
    }
  }

  const controller: AutonomousController = {
    onSettled: (result, detail) => resolveSettle({ result, detail }),
    onPerception: text => inbox.push(text),
    onChat: (username, message) => inbox.push(`[CHAT ${username}] ${message}`),
    stop: () => {
      running = false
      resolveSettle({ result: 'stopped' })
    },
  }

  function buildTickContent(): string {
    const events = inbox.splice(0)
    const lines = [
      `OBJECTIVE: ${deps.goal}`,
      `TURN: ${tick}`,
      `RESULT OF YOUR PREVIOUS ACTIONS: ${lastResult}`,
    ]
    if (events.length > 0) {
      lines.push(`RECENT IN-GAME MESSAGES (newest last):\n${events.join('\n')}`)
    }
    lines.push('Decide your single next concrete step toward the objective and reply with the JSON object. If unsure of your inventory or a recipe, call the observation tools first.')
    return lines.join('\n')
  }

  async function waitForSettle(): Promise<SettleResult> {
    return new Promise<SettleResult>((resolve) => {
      settle = resolve
      setTimeout(() => resolveSettle({ result: 'timeout' }), SETTLE_TIMEOUT_MS)
    })
  }

  async function loop() {
    logger.withFields({ goal: deps.goal, tickDelayMs: deps.tickDelayMs }).log('Autonomous play loop started')

    // eslint-disable-next-line no-unmodified-loop-condition -- flipped by stop() through the closure
    while (running) {
      tick++

      let decision: LLMMessage | null = null
      try {
        decision = await deps.handler.handleMessage({ type: 'autonomousTick', content: buildTickContent() })
      }
      catch (e: unknown) {
        logger.withFields({ tick, error: e instanceof Error ? e.message : String(e) }).error('Decision failed')
        lastResult = 'Your last reasoning attempt errored out. Try a simpler, single next step.'
        await sleep(deps.tickDelayMs)
        continue
      }

      if (!decision) {
        lastResult = 'No valid decision was produced (parsing failed). Reply with a simpler step.'
        await sleep(deps.tickDelayMs)
        continue
      }

      if (decision.chatMessage) {
        logger.withFields({ tick }).log(`🤖 ${decision.chatMessage}`)
        await deps.say(decision.chatMessage).catch(() => {})
      }

      if (!decision.operationCommands || decision.operationCommands.length === 0) {
        lastResult = 'You only observed/thought last turn and issued no operations. Now take a concrete action toward the objective.'
        await sleep(deps.tickDelayMs)
        continue
      }

      logger.withFields({ tick, commands: decision.operationCommands }).log('Executing operations')
      // Arm the settle waiter BEFORE executing. The mod can emit its result (e.g. an
      // immediate "[ERROR] No X found in radius") before execute()'s HTTP round-trip even
      // returns; if we armed the waiter afterwards we'd miss that signal and wait out the
      // full timeout (~3-min stalls on immediate errors). Arming first closes the race.
      const settlePromise = waitForSettle()
      try {
        await deps.execute(decision.operationCommands)
      }
      catch (e: unknown) {
        resolveSettle({ result: 'error', detail: `failed to dispatch operations: ${e instanceof Error ? e.message : String(e)}` })
      }

      const outcome = await settlePromise
      if (outcome.result === 'stopped') {
        break
      }
      else if (outcome.result === 'completed') {
        lastResult = `Your actions completed successfully: ${decision.operationCommands.join(' ; ')}`
      }
      else if (outcome.result === 'error') {
        lastResult = `Your actions FAILED: ${outcome.detail ?? 'unknown error'}. Adapt — e.g. widen the search radius, craft a missing prerequisite, or walk closer first.`
      }
      else {
        lastResult = 'Your actions did not finish within the time limit (you may be stuck). Re-assess with getPlayerStatus and try a different approach.'
      }

      await sleep(deps.tickDelayMs)
    }

    logger.log('Autonomous play loop stopped')
  }

  void loop()
  return controller
}

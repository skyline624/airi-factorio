import type { LLMMessage, PlayerEventMessage } from './parser'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from 'node:process'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { connect } from 'it-ws'
import { startAiriBridge } from './airi/bridge'
import { startAutonomousLoop } from './autonomous'
import { airiConfig, autonomousConfig, debugConfig, factorioConfig, initEnv, learningConfig, openaiConfig, rconClientConfig, wsClientConfig } from './config'
import { startLearningSession } from './learning/session'
import { buildPlayerPresenceCommand, buildScreenshotCommand } from './learning/state'
import { createMessageHandler } from './llm/message-handler'
import autonomousVisionPrompt from './llm/prompt-autonomous-vision.md?raw'
import autonomousPrompt from './llm/prompt-autonomous.md?raw'
import { parseChatMessage, parseLLMMessage, parseModErrorMessage, parseOperationCompletedMessage, parsePlayerEventMessage } from './parser'
import { initRcon, rconCommand, rconSay } from './rcon'

setGlobalFormat(Format.Pretty)
const logger = useLogg('main').useGlobalConfig()

// Throttle player events forwarded to the LLM (real-time ms, distinct from the
// in-game tick throttle on the mod side) to avoid spamming / accumulating calls.
const lastForwardedAt = new Map<string, number>()
const eventMinIntervalMs = new Map<string, number>([
  ['damaged', 5000],
  ['low_health', 10000],
  ['enemies_spotted', 8000],
  ['structure_lost', 8000],
  ['enemies_cleared', 0],
  ['health_recovered', 0],
  ['attack_ended', 0],
  ['died', 0],
])

// Gated `say`: when DEBUG_AGENT_SAY=false, the agent's action chatter
// (new objectives, success/failure summaries, autonomous decisions) is
// suppressed in the in-game chat. Chat replies to direct human messages
// are routed through `rconSay` directly and bypass this gate.
async function gatedSay(message: string): Promise<void> {
  if (debugConfig.agentSay) {
    await rconSay(message)
  }
}

function shouldForwardEvent(message: PlayerEventMessage): boolean {
  const now = Date.now()
  const min = eventMinIntervalMs.get(message.eventType) ?? 5000
  if (now - (lastForwardedAt.get(message.eventType) ?? 0) < min) {
    return false
  }
  lastForwardedAt.set(message.eventType, now)
  return true
}

// Vision-backed decision: capture a screenshot via the connected client, send it with the
// tick context to a vision model (e.g. gemma4), and parse its JSON action. Falls back to a
// text-only request if no screenshot is available (headless server / no client connected).
async function visionDecide(tickContent: string): Promise<LLMMessage | null> {
  const shot = 'airi-auto-view.png'
  try {
    await rconCommand(buildScreenshotCommand(shot, factorioConfig.playerName))
  }
  catch { /* ignore screenshot dispatch errors */ }
  await new Promise(resolve => setTimeout(resolve, 1500))

  let imageUrl: string | undefined
  try {
    const pngPath = join(env.APPDATA ?? '', 'Factorio', 'script-output', shot)
    imageUrl = `data:image/png;base64,${readFileSync(pngPath).toString('base64')}`
  }
  catch {
    logger.warn('No screenshot available (is the client connected?) — deciding from text only')
  }

  const userContent = imageUrl
    // eslint-disable-next-line ts/naming-convention -- `image_url` is the OpenAI vision API field name
    ? [{ type: 'text', text: tickContent }, { type: 'image_url', image_url: { url: imageUrl } }]
    : tickContent

  const baseURL = openaiConfig.baseUrl || 'https://api.openai.com/v1'
  try {
    const response = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      // eslint-disable-next-line ts/naming-convention -- standard HTTP header names
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${openaiConfig.apiKey || 'sk-no-key'}` },
      body: JSON.stringify({
        model: autonomousConfig.visionModel,
        stream: false,
        messages: [
          { role: 'system', content: autonomousVisionPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    })
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content
    if (!content) {
      logger.error('Vision model returned no content')
      return null
    }
    return parseLLMMessage(content)
  }
  catch (e: unknown) {
    logger.withFields({ error: e instanceof Error ? e.message : String(e) }).error('Vision decision failed')
    return null
  }
}

// Preflight gate: a dedicated server has NO character to control — and barely ticks —
// until a client connects. Starting the action loop then would time out every motor op
// (walk/mine/place) and burn LLM tokens against a frozen world. So block until the
// agent's target player (FACTORIO_PLAYER_NAME, or the first connected player) is in-game.
async function waitForPlayer(): Promise<void> {
  const cmd = buildPlayerPresenceCommand(factorioConfig.playerName)
  const target = factorioConfig.playerName || '(first connected player)'
  let polls = 0
  for (;;) {
    let ready = false
    try {
      ready = (await rconCommand(cmd)).includes('READY')
    }
    catch {
      ready = false // RCON not up yet / transient — keep waiting
    }
    if (ready) {
      logger.withFields({ player: target }).log('Player is in-game — starting the agent')
      return
    }
    // Warn immediately, then re-log a heartbeat every ~30s so the wait is visible.
    if (polls % 10 === 0) {
      logger.withFields({ player: target }).warn('Waiting for a player to connect (no character to control; server is paused)…')
    }
    polls += 1
    await new Promise(resolve => setTimeout(resolve, 3000))
  }
}

async function main() {
  initEnv()

  initRcon(rconClientConfig)

  const ws = connect(`ws://${wsClientConfig.wsHost}:${wsClientConfig.wsPort}`)

  const gameLogger = useLogg('game').useGlobalConfig()

  // Don't start any action loop until there's a character in-game to drive.
  if (learningConfig.enabled || autonomousConfig.enabled) {
    await waitForPlayer()
  }

  // --- Learning mode (Voyager-inspired): the agent WRITES & runs skill code. ---
  // Takes precedence over autonomous/reactive modes when enabled.
  if (learningConfig.enabled) {
    logger.withFields({ objective: learningConfig.objective }).log('Starting in LEARNING mode (action-as-code)')
    const raw = async (input: string): Promise<string> => rconCommand(input)
    const session = startLearningSession({
      raw,
      say: gatedSay,
      playerName: factorioConfig.playerName,
      curriculumEnabled: learningConfig.curriculumEnabled,
      ultimateGoal: learningConfig.ultimateGoal,
      maxObjectives: learningConfig.maxObjectives,
      // Used only when curriculumEnabled is false; ' | '-separated.
      objectives: learningConfig.objective.split('|').map(s => s.trim()).filter(Boolean),
      actionModel: learningConfig.actionModel || openaiConfig.model,
      criticModel: learningConfig.criticModel || openaiConfig.model,
      embeddingModel: learningConfig.embeddingModel,
      embeddingBaseUrl: learningConfig.embeddingBaseUrl || openaiConfig.baseUrl,
      skillsDir: learningConfig.skillsDir,
      sandboxTimeoutMs: learningConfig.sandboxTimeoutMs,
      settleTimeoutMs: learningConfig.settleTimeoutMs,
      maxOpsPerSkill: learningConfig.maxOpsPerSkill,
      maxRetries: learningConfig.maxRetries,
      deterministicCritic: learningConfig.deterministicCritic,
      gameDataCache: learningConfig.gameDataCache,
    })

    for await (const buffer of ws.source) {
      const line = Buffer.from(buffer).toString('utf-8')

      const modErrorMessage = parseModErrorMessage(line)
      if (modErrorMessage) {
        gameLogger.withContext('mod').error(modErrorMessage.error)
        session.onSettled('error', modErrorMessage.error)
        continue
      }

      const operationCompletedMessage = parseOperationCompletedMessage(line)
      if (operationCompletedMessage) {
        session.onSettled('completed')
        continue
      }

      const playerEventMessage = parsePlayerEventMessage(line)
      if (playerEventMessage) {
        session.onPerception(`[STATUS] ${playerEventMessage.eventType} ${playerEventMessage.raw}`.trim())
        continue
      }

      const chatMessage = parseChatMessage(line)
      if (chatMessage && !chatMessage.isServer) {
        session.onChat(chatMessage.username, chatMessage.message)
        continue
      }
    }
    return
  }

  // --- Autonomous play mode: the agent drives itself; no human task required. ---
  if (autonomousConfig.enabled) {
    logger.withFields({ goal: autonomousConfig.goal, vision: autonomousConfig.visionEnabled }).log('Starting in AUTONOMOUS mode')
    let decide: (tickContent: string) => Promise<LLMMessage | null>
    if (autonomousConfig.visionEnabled) {
      logger.withFields({ model: autonomousConfig.visionModel }).log('Autonomous VISION mode: a vision model sees the screen each turn')
      decide = visionDecide
    }
    else {
      const autoHandler = await createMessageHandler(autonomousPrompt)
      decide = tickContent => autoHandler.handleMessage({ type: 'autonomousTick', content: tickContent })
    }
    const controller = startAutonomousLoop({
      decide,
      goal: autonomousConfig.goal,
      tickDelayMs: autonomousConfig.tickDelayMs,
      execute: async (commands) => {
        await rconCommand(`/c ${commands.join(';')}`)
      },
      say: gatedSay,
    })

    for await (const buffer of ws.source) {
      const line = Buffer.from(buffer).toString('utf-8')

      const modErrorMessage = parseModErrorMessage(line)
      if (modErrorMessage) {
        gameLogger.withContext('mod').error(modErrorMessage.error)
        controller.onSettled('error', modErrorMessage.error)
        continue
      }

      const operationCompletedMessage = parseOperationCompletedMessage(line)
      if (operationCompletedMessage) {
        gameLogger.withContext('mod').log('All operations completed')
        controller.onSettled('completed')
        continue
      }

      const playerEventMessage = parsePlayerEventMessage(line)
      if (playerEventMessage) {
        gameLogger.withContext('mod').log(`[EVENT] ${playerEventMessage.eventType} ${playerEventMessage.raw}`)
        controller.onPerception(`[STATUS] ${playerEventMessage.eventType} ${playerEventMessage.raw}`.trim())
        continue
      }

      const chatMessage = parseChatMessage(line)
      if (chatMessage && !chatMessage.isServer) {
        gameLogger.withContext('chat').log(`${chatMessage.username}: ${chatMessage.message}`)
        controller.onChat(chatMessage.username, chatMessage.message)
        continue
      }
    }
    return
  }

  // --- Reactive mode (default): the SAME action-as-code engine as learning, but the
  // objectives come from the HUMAN CHAT (and the AIRI general) — no curriculum, no goal.
  // One unified engine (renderMap/placeAt/skills/critic); the mode only changes the
  // objective source. (Replaces the old prompt.md/operationCommands reactive path.)
  await waitForPlayer()
  logger.log('Starting in REACTIVE mode (chat-driven action-as-code)')
  const raw = async (input: string): Promise<string> => rconCommand(input)
  const session = startLearningSession({
    raw,
    say: gatedSay,
    playerName: factorioConfig.playerName,
    reactive: true,
    curriculumEnabled: false,
    ultimateGoal: '',
    maxObjectives: 0,
    objectives: [],
    actionModel: learningConfig.actionModel || openaiConfig.model,
    criticModel: learningConfig.criticModel || openaiConfig.model,
    embeddingModel: learningConfig.embeddingModel,
    embeddingBaseUrl: learningConfig.embeddingBaseUrl || openaiConfig.baseUrl,
    skillsDir: learningConfig.skillsDir,
    sandboxTimeoutMs: learningConfig.sandboxTimeoutMs,
    settleTimeoutMs: learningConfig.settleTimeoutMs,
    maxOpsPerSkill: learningConfig.maxOpsPerSkill,
    maxRetries: learningConfig.maxRetries,
    deterministicCritic: learningConfig.deterministicCritic,
    gameDataCache: learningConfig.gameDataCache,
  })

  // A spark:command from the AIRI general is a chat-equivalent objective.
  const airiBridge = await startAiriBridge(airiConfig, (text) => {
    session.onChat('AIRI', text)
    return Promise.resolve()
  })

  for await (const buffer of ws.source) {
    const line = Buffer.from(buffer).toString('utf-8')

    const modErrorMessage = parseModErrorMessage(line)
    if (modErrorMessage) {
      gameLogger.withContext('mod').error(modErrorMessage.error)
      session.onSettled('error', modErrorMessage.error)
      continue
    }

    const operationCompletedMessage = parseOperationCompletedMessage(line)
    if (operationCompletedMessage) {
      session.onSettled('completed')
      continue
    }

    const playerEventMessage = parsePlayerEventMessage(line)
    if (playerEventMessage) {
      gameLogger.withContext('mod').log(`[EVENT] ${playerEventMessage.eventType} ${playerEventMessage.raw}`)
      if (shouldForwardEvent(playerEventMessage)) {
        airiBridge?.notifyEvent(playerEventMessage)
      }
      session.onPerception(`[STATUS] ${playerEventMessage.eventType} ${playerEventMessage.raw}`.trim())
      continue
    }

    const chatMessage = parseChatMessage(line)
    if (chatMessage && !chatMessage.isServer) {
      gameLogger.withContext('chat').log(`${chatMessage.username}: ${chatMessage.message}`)
      airiBridge?.sendContextUpdate(`[player] ${chatMessage.username}: ${chatMessage.message}`, undefined, 'factorio:player')
      session.onChat(chatMessage.username, chatMessage.message)
      continue
    }
  }
}

main().catch((e: Error) => {
  logger.error(e.message)
  logger.error(e.stack)
})

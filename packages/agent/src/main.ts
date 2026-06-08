import type { AiriBridge } from './airi/bridge'
import type { MessageHandler } from './llm/message-handler'
import type { ChatMessage, LLMMessage, PlayerEventMessage, StdoutMessage } from './parser'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from 'node:process'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { backOff } from 'exponential-backoff'
import { client, v2FactorioConsoleCommandMessagePost, v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { connect } from 'it-ws'
import { startAiriBridge } from './airi/bridge'
import { startAutonomousLoop } from './autonomous'
import { airiConfig, autonomousConfig, initEnv, openaiConfig, rconClientConfig, wsClientConfig } from './config'
import { createMessageHandler } from './llm/message-handler'
import autonomousVisionPrompt from './llm/prompt-autonomous-vision.md?raw'
import autonomousPrompt from './llm/prompt-autonomous.md?raw'
import { parseChatMessage, parseLLMMessage, parseModErrorMessage, parseOperationCompletedMessage, parsePlayerEventMessage } from './parser'

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

function shouldForwardEvent(message: PlayerEventMessage): boolean {
  const now = Date.now()
  const min = eventMinIntervalMs.get(message.eventType) ?? 5000
  if (now - (lastForwardedAt.get(message.eventType) ?? 0) < min) {
    return false
  }
  lastForwardedAt.set(message.eventType, now)
  return true
}

async function executeCommandFromAgent<T extends StdoutMessage>(message: T, messageHandler: MessageHandler, airiBridge?: AiriBridge | null) {
  const llmResponse = await backOff(() => messageHandler.handleMessage(message), {
    timeMultiple: 2,
    maxDelay: 10000,
    retry(e, attemptNumber) {
      logger.withFields({ error: e.message, attemptNumber }).error('Failed to handle message, attempt to retry')
      return true
    },
  })

  if (!llmResponse) {
    logger.error('Failed to handle message')
    return
  }

  await v2FactorioConsoleCommandMessagePost({
    body: {
      message: llmResponse.chatMessage,
    },
  })

  // Keep the general in the loop: mirror what the bot says back as passive context.
  if (llmResponse.chatMessage) {
    airiBridge?.sendContextUpdate(`[bot] ${llmResponse.chatMessage}`, undefined, 'factorio:agent')
  }

  if (llmResponse.operationCommands.length === 0) {
    return
  }

  logger.withFields({ operationCommands: llmResponse.operationCommands, currentStep: llmResponse.currentStep }).debug('Executing operation commands')

  const command = llmResponse.operationCommands.join(';')
  await v2FactorioConsoleCommandRawPost({
    body: {
      input: `/c ${command}`,
    },
  })
}

// Serialize all agent turns (main loop + AIRI-relayed commands) so concurrent
// handleMessage calls never interleave the LLM conversation history.
let agentChain: Promise<unknown> = Promise.resolve()
function enqueueAgentTask(task: () => Promise<void>): Promise<void> {
  const run = agentChain.then(task, task)
  agentChain = run.catch(() => {})
  return run
}

// Vision-backed decision: capture a screenshot via the connected client, send it with the
// tick context to a vision model (e.g. gemma4), and parse its JSON action. Falls back to a
// text-only request if no screenshot is available (headless server / no client connected).
async function visionDecide(tickContent: string): Promise<LLMMessage | null> {
  const shot = 'airi-auto-view.png'
  try {
    await v2FactorioConsoleCommandRawPost({ body: { input: `/c local p=game.get_player(1); if p and p.connected then game.take_screenshot{by_player=p, position=p.position, resolution={384,384}, zoom=0.5, path='${shot}', show_gui=false, show_entity_info=true} end` } })
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

async function main() {
  initEnv()

  client.setConfig({
    baseUrl: `http://${rconClientConfig.host}:${rconClientConfig.port}`,
  })

  const ws = connect(`ws://${wsClientConfig.wsHost}:${wsClientConfig.wsPort}`)

  const gameLogger = useLogg('game').useGlobalConfig()

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
        await v2FactorioConsoleCommandRawPost({ body: { input: `/c ${commands.join(';')}` } })
      },
      say: async (message) => {
        await v2FactorioConsoleCommandMessagePost({ body: { message } })
      },
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

  const messageHandler = await createMessageHandler()

  // Optional bridge to the AIRI "general". A spark:command from the general is treated
  // exactly like a chat message from the master (same decision path).
  const airiBridge = await startAiriBridge(airiConfig, (text) => {
    const chatMsg: ChatMessage = {
      type: 'chat',
      username: 'AIRI',
      message: text,
      isServer: false,
      date: new Date().toISOString(),
    }
    return enqueueAgentTask(() => executeCommandFromAgent(chatMsg, messageHandler, airiBridge))
  })

  for await (const buffer of ws.source) {
    const line = Buffer.from(buffer).toString('utf-8')

    const chatMessage = parseChatMessage(line)
    if (chatMessage) {
      if (chatMessage.isServer) {
        continue
      }

      gameLogger.withContext('chat').log(`${chatMessage.username}: ${chatMessage.message}`)

      await enqueueAgentTask(() => executeCommandFromAgent(chatMessage, messageHandler, airiBridge))
      continue
    }

    const modErrorMessage = parseModErrorMessage(line)
    if (modErrorMessage) {
      gameLogger.withContext('mod').error(`${modErrorMessage.error}`)

      await enqueueAgentTask(() => executeCommandFromAgent(modErrorMessage, messageHandler, airiBridge))
      continue
    }

    const operationCompletedMessage = parseOperationCompletedMessage(line)
    if (operationCompletedMessage) {
      gameLogger.withContext('mod').log(`All operations completed`)

      await enqueueAgentTask(() => executeCommandFromAgent(operationCompletedMessage, messageHandler, airiBridge))
      continue
    }

    const playerEventMessage = parsePlayerEventMessage(line)
    if (playerEventMessage) {
      gameLogger.withContext('mod').log(`[EVENT] ${playerEventMessage.eventType} ${playerEventMessage.raw}`)

      if (shouldForwardEvent(playerEventMessage)) {
        // Alert the general (same throttle as the local LLM) and let the local agent react.
        airiBridge?.notifyEvent(playerEventMessage)
        await enqueueAgentTask(() => executeCommandFromAgent(playerEventMessage, messageHandler, airiBridge))
      }
      continue
    }
  }
}

main().catch((e: Error) => {
  logger.error(e.message)
  logger.error(e.stack)
})

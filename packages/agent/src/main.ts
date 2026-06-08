import type { AiriBridge } from './airi/bridge'
import type { MessageHandler } from './llm/message-handler'
import type { ChatMessage, PlayerEventMessage, StdoutMessage } from './parser'
import { Buffer } from 'node:buffer'
import { Format, setGlobalFormat, useLogg } from '@guiiai/logg'
import { backOff } from 'exponential-backoff'
import { client, v2FactorioConsoleCommandMessagePost, v2FactorioConsoleCommandRawPost } from 'factorio-rcon-api-client'
import { connect } from 'it-ws'
import { startAiriBridge } from './airi/bridge'
import { startAutonomousLoop } from './autonomous'
import { airiConfig, autonomousConfig, initEnv, rconClientConfig, wsClientConfig } from './config'
import { createMessageHandler } from './llm/message-handler'
import autonomousPrompt from './llm/prompt-autonomous.md?raw'
import { parseChatMessage, parseModErrorMessage, parseOperationCompletedMessage, parsePlayerEventMessage } from './parser'

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

async function main() {
  initEnv()

  client.setConfig({
    baseUrl: `http://${rconClientConfig.host}:${rconClientConfig.port}`,
  })

  const ws = connect(`ws://${wsClientConfig.wsHost}:${wsClientConfig.wsPort}`)

  const gameLogger = useLogg('game').useGlobalConfig()

  // --- Autonomous play mode: the agent drives itself; no human task required. ---
  if (autonomousConfig.enabled) {
    logger.withFields({ goal: autonomousConfig.goal }).log('Starting in AUTONOMOUS mode')
    const autoHandler = await createMessageHandler(autonomousPrompt)
    const controller = startAutonomousLoop({
      handler: autoHandler,
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

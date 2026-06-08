import type { DefinedTool, Message } from 'neuri/openai'

import type { StdoutMessage } from '../parser'
import { createLogg } from '@guiiai/logg'
import { assistant, composeAgent, defineToolFunction, system, toolFunction, user } from 'neuri/openai'
import { openaiConfig } from '../config'
import { parseLLMMessage } from '../parser'
import prompt from './prompt.md?raw'
import { tools } from './tools'

const logger = createLogg('agent').useGlobalConfig()

export async function createMessageHandler(systemPromptOverride?: string) {
  const toolFunctions: DefinedTool<any, any>[] = []

  for (const tool of tools) {
    toolFunctions.push(defineToolFunction(await toolFunction(tool.name, tool.description, tool.schema), tool.fn))
  }

  const agent = composeAgent({
    provider: {
      // A custom baseURL means a local / OpenAI-compatible server (Ollama, LM
      // Studio, vLLM…), which usually wants a non-empty (but ignored) key.
      apiKey: openaiConfig.apiKey || (openaiConfig.baseUrl ? 'sk-no-key' : ''),
      // Empty -> the default OpenAI endpoint.
      baseURL: openaiConfig.baseUrl || 'https://api.openai.com/v1',
    },
    tools: toolFunctions,
  })

  const messages: Message[] = [system(systemPromptOverride ?? prompt)]

  // Keep the conversation bounded (token cost + context window). Always keep the
  // system prompt at index 0 and drop the oldest user/assistant pairs past the cap.
  const maxHistoryMessages = 40
  function trimHistory() {
    while (messages.length > maxHistoryMessages + 1) {
      messages.splice(1, 2)
    }
  }

  async function handleMessage(message: StdoutMessage) {
    logger.withFields({ message }).debug('Handling message')

    let userContent: string | null = null
    if (message.type === 'chat') {
      userContent = `[CHAT] ${message.message}`
    }
    else if (message.type === 'modError') {
      userContent = `[MOD] Error: ${message.error}`
    }
    else if (message.type === 'operationsCompleted') {
      userContent = `[MOD] All operations completed`
    }
    else if (message.type === 'playerEvent') {
      const f = message.fields
      if (message.eventType === 'damaged') {
        userContent = `[STATUS] Taking damage. health=${f.health ?? '?'}/${f.max_health ?? '?'} (ratio ${f.ratio ?? '?'}), cause=${f.cause ?? 'unknown'}.`
      }
      else if (message.eventType === 'low_health') {
        userContent = `[STATUS] WARNING: low health (ratio ${f.ratio ?? '?'}). Consider fleeing or fighting back.`
      }
      else if (message.eventType === 'health_recovered') {
        userContent = `[STATUS] Health recovered (ratio ${f.ratio ?? '?'}).`
      }
      else if (message.eventType === 'enemies_spotted') {
        userContent = `[STATUS] ${f.count ?? '?'} enemy/enemies nearby. Nearest: ${f.nearest ?? '?'} at ${f.distance ?? '?'}m.`
      }
      else if (message.eventType === 'enemies_cleared') {
        userContent = `[STATUS] No more enemies nearby.`
      }
      else if (message.eventType === 'attack_ended') {
        userContent = `[STATUS] The attack has ended (no damage taken recently).`
      }
      else if (message.eventType === 'structure_lost') {
        userContent = `[STATUS] ${f.count ?? '?'} of your structure(s) were destroyed.`
      }
      else if (message.eventType === 'died') {
        userContent = `[STATUS] You died (cause=${f.cause ?? 'unknown'}).`
      }
      else {
        userContent = `[STATUS] ${message.eventType} ${message.raw}`
      }
    }
    else if (message.type === 'autonomousTick') {
      userContent = message.content
    }

    // Build the request without mutating the persisted history yet, so a failed
    // attempt (and its backoff retry) doesn't duplicate the user message.
    const requestMessages = userContent ? [...messages, user(userContent)] : messages

    const response = await agent.call(requestMessages, {
      model: openaiConfig.model,
      maxRoundTrip: 10,
    })

    if (!response) {
      logger.withFields({ response }).error('LLM responded with null')
      return null
    }

    if (!response.choices || !response.choices.length) {
      logger.withFields({ response }).error('LLM responded with no choices')
      return null
    }

    const messageFromLLM = response.choices[0].message.content
    logger.withFields({ messageFromLLM }).debug('Message response from LLM')
    if (!messageFromLLM) {
      return null
    }

    const parsedMessage = parseLLMMessage(messageFromLLM)

    // Commit to the persisted history only once parsing succeeds.
    if (userContent) {
      messages.push(user(userContent))
    }
    messages.push(assistant(`${JSON.stringify(parsedMessage)}`))

    trimHistory()

    return parsedMessage
  }

  return {
    handleMessage,
  }
}

export type MessageHandler = Awaited<ReturnType<typeof createMessageHandler>>

import type { DefinedTool, Message } from 'neuri/openai'

import type { StdoutMessage } from '../parser'
import { createLogg } from '@guiiai/logg'
import { assistant, composeAgent, defineToolFunction, system, toolFunction, user } from 'neuri/openai'
import { openaiConfig } from '../config'
import { parseLLMMessage } from '../parser'
import prompt from './prompt.md?raw'
import { tools } from './tools'

const logger = createLogg('agent').useGlobalConfig()

export async function createMessageHandler() {
  const toolFunctions: DefinedTool<any, any>[] = []

  for (const tool of tools) {
    toolFunctions.push(defineToolFunction(await toolFunction(tool.name, tool.description, tool.schema), tool.fn))
  }

  const agent = composeAgent({
    provider: {
      apiKey: openaiConfig.apiKey,
      baseURL: openaiConfig.baseUrl,
    },
    tools: toolFunctions,
  })

  const messages: Message[] = [system(prompt)]

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

    return parsedMessage
  }

  return {
    handleMessage,
  }
}

export type MessageHandler = Awaited<ReturnType<typeof createMessageHandler>>

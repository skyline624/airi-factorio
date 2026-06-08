import type { FactorioRconAPIClientConfig, FactorioWsConfig, OpenAIConfig } from './types.js'
import { env } from 'node:process'
import { useLogg } from '@guiiai/logg'

const logger = useLogg('config').useGlobalConfig()

export const openaiConfig: OpenAIConfig = {
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4o',
}

export const rconClientConfig: FactorioRconAPIClientConfig = {
  host: '',
  port: 0,
}

export const wsClientConfig: FactorioWsConfig = {
  wsHost: '',
  wsPort: 0,
}

export function initEnv() {
  logger.log('Initializing environment variables')

  openaiConfig.apiKey = (env.OPENAI_API_KEY || '').trim()
  openaiConfig.baseUrl = (env.OPENAI_API_BASEURL || '').trim()
  openaiConfig.model = (env.OPENAI_MODEL || 'gpt-4o').trim()

  if (!openaiConfig.baseUrl && !openaiConfig.apiKey) {
    logger.warn('No OPENAI_API_KEY and no OPENAI_API_BASEURL set: requests to the default OpenAI endpoint will fail. Set a key, or point OPENAI_API_BASEURL at a local OpenAI-compatible server (Ollama, LM Studio, vLLM…).')
  }

  rconClientConfig.host = env.RCON_API_SERVER_HOST || 'localhost'
  rconClientConfig.port = Number.parseInt(env.RCON_API_SERVER_PORT || '24180')

  wsClientConfig.wsHost = env.FACTORIO_WS_HOST || 'localhost'
  wsClientConfig.wsPort = Number.parseInt(env.FACTORIO_WS_PORT || '8080')

  logger.withFields({ openaiConfig }).log('Environment variables initialized')
}

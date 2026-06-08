import type { AiriConfig, FactorioRconAPIClientConfig, FactorioWsConfig, OpenAIConfig } from './types.js'
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

export const airiConfig: AiriConfig = {
  enabled: false,
  url: 'ws://localhost:6121/ws',
  name: 'factorio',
  token: '',
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

  // AIRI "general" bridge. Opt-in: the agent stays standalone unless AIRI_ENABLED=true,
  // so existing local-test workflows (agent + Factorio only) are unaffected.
  airiConfig.enabled = (env.AIRI_ENABLED || 'false').trim().toLowerCase() === 'true'
  airiConfig.url = (env.AIRI_WS_URL || 'ws://localhost:6121/ws').trim()
  airiConfig.name = (env.AIRI_MODULE_NAME || 'factorio').trim()
  airiConfig.token = (env.AIRI_WS_TOKEN || '').trim()

  logger.withFields({ openaiConfig, airiConfig }).log('Environment variables initialized')
}

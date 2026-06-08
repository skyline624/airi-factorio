import type { AiriConfig, AutonomousConfig, FactorioRconAPIClientConfig, FactorioWsConfig, LearningConfig, OpenAIConfig } from './types.js'
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

export const autonomousConfig: AutonomousConfig = {
  enabled: false,
  goal: 'Automate iron plate production: secure a small base, mine iron ore and coal, place burner mining drills on ore patches and stone furnaces next to them, fuel everything with coal, and accumulate at least 50 iron plates.',
  tickDelayMs: 1500,
  visionEnabled: false,
  visionModel: 'gemma4:31b-cloud',
}

export const learningConfig: LearningConfig = {
  enabled: false,
  curriculumEnabled: true,
  ultimateGoal: 'Launch a rocket.',
  maxObjectives: 6,
  objective: 'Mine 10 iron ore and 5 coal.',
  actionModel: '',
  criticModel: '',
  embeddingModel: 'qwen3-embedding:8b',
  embeddingBaseUrl: '',
  skillsDir: './skills',
  sandboxTimeoutMs: 120_000,
  settleTimeoutMs: 60_000,
  maxOpsPerSkill: 200,
  maxRetries: 4,
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

  // Autonomous play loop. Opt-in: without it the agent stays purely reactive.
  autonomousConfig.enabled = (env.AUTONOMOUS_MODE || 'false').trim().toLowerCase() === 'true'
  autonomousConfig.goal = (env.AUTONOMOUS_GOAL || autonomousConfig.goal).trim()
  autonomousConfig.tickDelayMs = Number.parseInt(env.AUTONOMOUS_TICK_DELAY_MS || '1500')
  autonomousConfig.visionEnabled = (env.AUTONOMOUS_VISION || 'false').trim().toLowerCase() === 'true'
  autonomousConfig.visionModel = (env.AUTONOMOUS_VISION_MODEL || 'gemma4:31b-cloud').trim()

  // Voyager-inspired lifelong-learning loop (skill library + curriculum + critic).
  // Opt-in: without it the agent stays in its reactive / autonomous modes.
  learningConfig.enabled = (env.LEARNING_MODE || 'false').trim().toLowerCase() === 'true'
  learningConfig.curriculumEnabled = (env.LEARNING_CURRICULUM || 'true').trim().toLowerCase() === 'true'
  learningConfig.ultimateGoal = (env.LEARNING_GOAL || 'Launch a rocket.').trim()
  learningConfig.maxObjectives = Number.parseInt(env.LEARNING_MAX_OBJECTIVES || '6')
  learningConfig.objective = (env.LEARNING_OBJECTIVE || learningConfig.objective).trim()
  learningConfig.actionModel = (env.LEARNING_ACTION_MODEL || '').trim()
  learningConfig.criticModel = (env.LEARNING_CRITIC_MODEL || '').trim()
  learningConfig.embeddingModel = (env.LEARNING_EMBEDDING_MODEL || 'qwen3-embedding:8b').trim()
  learningConfig.embeddingBaseUrl = (env.LEARNING_EMBEDDING_BASEURL || '').trim()
  learningConfig.skillsDir = (env.LEARNING_SKILLS_DIR || './skills').trim()
  learningConfig.sandboxTimeoutMs = Number.parseInt(env.LEARNING_SANDBOX_TIMEOUT_MS || '120000')
  learningConfig.settleTimeoutMs = Number.parseInt(env.LEARNING_SETTLE_TIMEOUT_MS || '60000')
  learningConfig.maxOpsPerSkill = Number.parseInt(env.LEARNING_MAX_OPS || '200')
  learningConfig.maxRetries = Number.parseInt(env.LEARNING_MAX_RETRIES || '4')

  logger.withFields({ openaiConfig, airiConfig, autonomousConfig, learningConfig }).log('Environment variables initialized')
}

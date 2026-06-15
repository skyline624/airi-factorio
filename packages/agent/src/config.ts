import type { RconConfig } from './rcon.js'
import type { AiriConfig, AutonomousConfig, DebugConfig, FactorioConfig, FactorioWsConfig, LearningConfig, OpenAIConfig } from './types.js'
import { env } from 'node:process'
import { useLogg } from '@guiiai/logg'

const logger = useLogg('config').useGlobalConfig()

export const openaiConfig: OpenAIConfig = {
  apiKey: '',
  baseUrl: '',
  model: 'gpt-4o',
}

export const factorioConfig: FactorioConfig = {
  playerName: '',
}

export const debugConfig: DebugConfig = {
  agentSay: false,
}

export const rconClientConfig: RconConfig = {
  host: '',
  port: 0,
  password: '',
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
  deterministicCritic: true,
}

export function initEnv() {
  logger.log('Initializing environment variables')

  openaiConfig.apiKey = (env.OPENAI_API_KEY || '').trim()
  openaiConfig.baseUrl = (env.OPENAI_API_BASEURL || '').trim()
  openaiConfig.model = (env.OPENAI_MODEL || 'gpt-4o').trim()

  if (!openaiConfig.baseUrl && !openaiConfig.apiKey) {
    logger.warn('No OPENAI_API_KEY and no OPENAI_API_BASEURL set: requests to the default OpenAI endpoint will fail. Set a key, or point OPENAI_API_BASEURL at a local OpenAI-compatible server (Ollama, LM Studio, vLLM…).')
  }

  // Native Source-RCON connection straight to the Factorio server (no Docker / REST proxy).
  rconClientConfig.host = (env.RCON_HOST || env.RCON_API_SERVER_HOST || 'localhost').trim()
  rconClientConfig.port = Number.parseInt(env.RCON_PORT || '27015')
  rconClientConfig.password = (env.RCON_PASSWORD || '').trim()
  if (!rconClientConfig.password) {
    logger.warn('No RCON_PASSWORD set: the agent cannot authenticate to the Factorio RCON port. Set RCON_PASSWORD to match the server\'s --rcon-password.')
  }

  wsClientConfig.wsHost = env.FACTORIO_WS_HOST || 'localhost'
  wsClientConfig.wsPort = Number.parseInt(env.FACTORIO_WS_PORT || '8080')

  // In-game player the agent controls. Empty = auto-detect first connected
  // player (best-effort when the agent boots before the human joins).
  factorioConfig.playerName = (env.FACTORIO_PLAYER_NAME || '').trim()

  // When false, the agent stays quiet in the in-game chat and only replies
  // when spoken to. Node-side logs are unaffected. Set true for full chatter.
  debugConfig.agentSay = (env.DEBUG_AGENT_SAY || 'false').trim().toLowerCase() === 'true'

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
  // Settle mechanical objectives (mine/build/research) in code, skipping the critic-LLM
  // round-trip. Defaults on; set LEARNING_DETERMINISTIC_CRITIC=false to always use the LLM.
  learningConfig.deterministicCritic = (env.LEARNING_DETERMINISTIC_CRITIC || 'true').trim().toLowerCase() !== 'false'

  logger.withFields({ openaiConfig, factorioConfig, debugConfig, airiConfig, autonomousConfig, learningConfig }).log('Environment variables initialized')
}

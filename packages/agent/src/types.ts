export interface OpenAIConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface FactorioWsConfig {
  wsPort: number
  wsHost: string
}

export interface AutonomousConfig {
  /** When true, the agent plays Factorio on its own in a perceive→decide→act loop. */
  enabled: boolean
  /** The current high-level objective the agent works toward. */
  goal: string
  /** Delay (ms) between autonomous turns, to pace the LLM and let the world settle. */
  tickDelayMs: number
  /** When true, capture a screenshot each turn so a vision model can see + decide. */
  visionEnabled: boolean
  /** Vision-capable model used when visionEnabled (e.g. gemma4:31b-cloud). */
  visionModel: string
}

export interface LearningConfig {
  /** When true, the agent runs the Voyager-inspired lifelong-learning loop. */
  enabled: boolean
  /** When true, the curriculum proposes objectives automatically; else the fixed `objective` list is used. */
  curriculumEnabled: boolean
  /** The end goal the curriculum works toward. */
  ultimateGoal: string
  /** Max objectives to run in one session (bounds an autonomous run). */
  maxObjectives: number
  /** Fixed objective(s), ' | '-separated. Used when curriculumEnabled is false. */
  objective: string
  /** Capable code-generation model for the action agent (empty -> fall back to OPENAI_MODEL). */
  actionModel: string
  /** Model used by the critic / curriculum / skill-describer (empty -> fall back to OPENAI_MODEL). */
  criticModel: string
  /** Ollama embedding model used to index the skill library (step 4). */
  embeddingModel: string
  /** Base URL for the embeddings endpoint (empty -> reuse OPENAI_API_BASEURL). */
  embeddingBaseUrl: string
  /** Directory where learned skills are persisted (step 4). */
  skillsDir: string
  /** Wall-clock limit for a single skill's sandboxed execution (ms). */
  sandboxTimeoutMs: number
  /** Per-operation settle timeout (ms). Keep < sandboxTimeoutMs so a hung op fails first. */
  settleTimeoutMs: number
  /** Hard cap on operations a single skill may issue (runaway guard). */
  maxOpsPerSkill: number
  /** Max code-gen attempts per objective (Voyager iterative prompting). */
  maxRetries: number
  /** When true, settle mechanical objectives (mine/build/research) in code, skipping the critic-LLM round-trip. */
  deterministicCritic: boolean
  /** When true, cache static game-data lookups (recipe/entity/craft-plan) per session to cut redundant RCON round-trips. */
  gameDataCache: boolean
}

export interface AiriConfig {
  /** When false, the agent runs standalone (no connection to the AIRI general). */
  enabled: boolean
  /** WebSocket URL of the AIRI hub server (desktop app embeds it on :6121). */
  url: string
  /** Module name announced to AIRI (shown in the stage registry). */
  name: string
  /** Optional auth token (empty for the local desktop hub). */
  token: string
}

export interface FactorioConfig {
  /**
   * In-game player name the agent controls. Empty = auto-detect the first
   * connected player. Useful when the agent boots before a human joins, or
   * when multiple humans play on the same server.
   */
  playerName: string
}

export interface DebugConfig {
  /**
   * When true, the agent broadcasts its action messages in the in-game chat
   * (new objectives, success/failure summaries, autonomous decisions). When
   * false, the chat stays silent and the agent only replies when spoken to.
   * Node-side logs are always emitted.
   */
  agentSay: boolean
}

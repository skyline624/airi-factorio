export interface OpenAIConfig {
  apiKey: string
  baseUrl: string
  model: string
}

export interface FactorioWsConfig {
  wsPort: number
  wsHost: string
}

export interface FactorioRconAPIClientConfig {
  port: number
  host: string
}

export interface AutonomousConfig {
  /** When true, the agent plays Factorio on its own in a perceive→decide→act loop. */
  enabled: boolean
  /** The current high-level objective the agent works toward. */
  goal: string
  /** Delay (ms) between autonomous turns, to pace the LLM and let the world settle. */
  tickDelayMs: number
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

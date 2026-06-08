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

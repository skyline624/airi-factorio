export interface FactorioConfig {
  path: string
  savePath: string
  rconPassword: string
  rconPort: number
  configPath: string
  /** Path to a server-settings.json (e.g. `auto_pause:false` so the server keeps ticking with no client). */
  serverSettingsPath: string
}

export interface WsServerConfig {
  host: string
  port: number
}

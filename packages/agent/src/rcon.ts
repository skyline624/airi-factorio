import { Buffer } from 'node:buffer'
import net from 'node:net'
import { useLogg } from '@guiiai/logg'

const logger = useLogg('rcon').useGlobalConfig()

// Source RCON packet types.
const TYPE_AUTH = 3
const TYPE_EXEC = 2
const TYPE_AUTH_RESPONSE = 2
const COMMAND_TIMEOUT_MS = 30_000
const AUTH_TIMEOUT_MS = 8_000

export interface RconConfig {
  host: string
  port: number
  password: string
}

export interface RconClient {
  /** Run a console command (e.g. `/c ...`) and resolve with the server's response text. */
  command: (input: string) => Promise<string>
  close: () => void
}

interface Waiter {
  resolve: (body: string) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

function buildPacket(id: number, type: number, body: string): Buffer {
  const b = Buffer.from(body, 'utf8')
  const p = Buffer.alloc(b.length + 14) // 4 size + 4 id + 4 type + body + 2 nulls
  p.writeInt32LE(b.length + 10, 0)
  p.writeInt32LE(id, 4)
  p.writeInt32LE(type, 8)
  b.copy(p, 12)
  return p
}

/**
 * Minimal Factorio (Source) RCON client over raw TCP — replaces the external
 * factorio-rcon-api (Docker) REST wrapper, so the agent talks to the server's
 * RCON port directly. Responses are matched to requests by packet id (commands
 * may overlap); the connection lazily (re)connects + re-auths on drop.
 *
 * NOTE: assumes single-packet responses (the practical case for our commands);
 * the `scan_area` tool is capped to keep its JSON within one RCON packet.
 */
export function createRconClient(config: RconConfig): RconClient {
  let socket: net.Socket | null = null
  let buf = Buffer.alloc(0)
  let nextId = 1
  let connectPromise: Promise<void> | null = null
  const waiters = new Map<number, Waiter>()
  let authWaiter: { resolve: () => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> } | null = null

  function failAll(error: Error) {
    for (const w of waiters.values()) {
      clearTimeout(w.timer)
      w.reject(error)
    }
    waiters.clear()
    if (authWaiter) {
      clearTimeout(authWaiter.timer)
      authWaiter.reject(error)
      authWaiter = null
    }
  }

  function onData(data: Buffer) {
    buf = Buffer.concat([buf, data])
    while (buf.length >= 12) {
      const size = buf.readInt32LE(0)
      if (buf.length < size + 4) {
        break
      }
      const id = buf.readInt32LE(4)
      const type = buf.readInt32LE(8)
      const body = buf.toString('utf8', 12, 4 + size - 2)
      buf = buf.subarray(4 + size)

      if (type === TYPE_AUTH_RESPONSE && authWaiter) {
        const w = authWaiter
        authWaiter = null
        clearTimeout(w.timer)
        if (id === -1) {
          w.reject(new Error('RCON auth failed (wrong password?)'))
        }
        else {
          w.resolve()
        }
        continue
      }
      const w = waiters.get(id)
      if (w) {
        waiters.delete(id)
        clearTimeout(w.timer)
        w.resolve(body)
      }
    }
  }

  function connect(): Promise<void> {
    if (connectPromise) {
      return connectPromise
    }
    connectPromise = new Promise<void>((resolve, reject) => {
      buf = Buffer.alloc(0)
      const s = net.connect({ host: config.host, port: config.port })
      socket = s
      s.setNoDelay(true)
      s.on('data', onData)
      s.on('error', (e) => {
        logger.withFields({ error: e.message }).warn('RCON socket error')
        reject(e)
      })
      s.on('close', () => {
        if (socket === s) {
          socket = null
        }
        connectPromise = null
        failAll(new Error('RCON connection closed'))
      })
      s.once('connect', () => {
        const timer = setTimeout(() => {
          authWaiter = null
          reject(new Error('RCON auth timeout'))
        }, AUTH_TIMEOUT_MS)
        // On auth success, fire one throwaway command to absorb any stray
        // post-handshake packet, so the FIRST real command's response is reliable.
        authWaiter = {
          resolve: () => {
            clearTimeout(timer)
            const warmId = nextId++
            const warmTimer = setTimeout(() => {
              waiters.delete(warmId)
              resolve()
            }, 3000)
            waiters.set(warmId, {
              resolve: () => {
                clearTimeout(warmTimer)
                resolve()
              },
              reject: () => {
                clearTimeout(warmTimer)
                resolve()
              },
              timer: warmTimer,
            })
            s.write(buildPacket(warmId, TYPE_EXEC, '/c rcon.print("")'))
          },
          reject,
          timer,
        }
        s.write(buildPacket(nextId++, TYPE_AUTH, config.password))
      })
    })
    return connectPromise
  }

  async function ensure(): Promise<void> {
    if (socket && !socket.destroyed) {
      return
    }
    await connect()
  }

  return {
    async command(input: string): Promise<string> {
      await ensure()
      const s = socket
      if (!s) {
        throw new Error('RCON not connected')
      }
      return new Promise<string>((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          waiters.delete(id)
          reject(new Error('RCON command timed out'))
        }, COMMAND_TIMEOUT_MS)
        waiters.set(id, { resolve, reject, timer })
        s.write(buildPacket(id, TYPE_EXEC, input))
      })
    },
    close() {
      socket?.destroy()
      socket = null
      connectPromise = null
    },
  }
}

// --- Module singleton (mirrors the old global rcon-api client) ---
let singleton: RconClient | null = null

export function initRcon(config: RconConfig): RconClient {
  singleton = createRconClient(config)
  return singleton
}

/** Send a `/c ...` (or any) console command, resolving with the rcon.print output. */
export function rconCommand(input: string): Promise<string> {
  if (!singleton) {
    throw new Error('RCON client not initialized (call initRcon first)')
  }
  return singleton.command(input)
}

/** Broadcast a chat-style line to all players (via game.print). */
export function rconSay(message: string): Promise<string> {
  return rconCommand(`/c game.print(${JSON.stringify(message)})`)
}

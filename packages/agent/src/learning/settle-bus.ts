import type { SettleResult } from './types'

/** A batch of operations shouldn't realistically take longer than this. */
const DEFAULT_SETTLE_TIMEOUT_MS = 180_000

export interface SettleBus {
  /** Arm a one-shot waiter for the next in-game settle. Call BEFORE dispatching the op. */
  arm: () => Promise<SettleResult>
  /** Resolve the armed waiter (fed by the stdout / WS reader). */
  settle: (result: 'completed' | 'error', detail?: string) => void
  /** Abandon the armed waiter (e.g. the op failed synchronously, so no settle will come). */
  cancel: () => void
}

/**
 * A one-shot settle waiter shared between the WS/stdout reader and the `ops`
 * runtime. The reader calls `settle('completed'|'error', …)` when the mod prints
 * its result; `ops` arms a waiter *before* dispatching each operation (closing
 * the race where an immediate `[ERROR]` would otherwise be missed).
 */
export function createSettleBus(timeoutMs: number = DEFAULT_SETTLE_TIMEOUT_MS): SettleBus {
  let resolver: ((value: SettleResult) => void) | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function clear() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    resolver = null
  }

  function resolve(value: SettleResult) {
    const fn = resolver
    if (fn) {
      clear()
      fn(value)
    }
  }

  return {
    arm() {
      // A new arm supersedes any previous one (sequential op usage makes this rare).
      resolve({ result: 'cancelled' })
      return new Promise<SettleResult>((res) => {
        resolver = res
        timer = setTimeout(() => resolve({ result: 'timeout' }), timeoutMs)
      })
    },
    settle(result, detail) {
      resolve({ result, detail })
    },
    cancel() {
      resolve({ result: 'cancelled' })
    },
  }
}

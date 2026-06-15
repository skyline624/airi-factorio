import type { SettleResult } from './types'

// Backstop only: a single op shouldn't realistically take this long, and the mod
// already fast-fails most stuck cases via [ERROR] (path abandon, mine stall watchdog,
// nothing-moved). Production passes LEARNING_SETTLE_TIMEOUT_MS (60s); this default just
// matches it so a bus created without an explicit timeout behaves the same.
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000

export interface SettleBus {
  /** Arm a one-shot waiter for the next in-game settle. Call BEFORE dispatching the op. */
  arm: () => Promise<SettleResult>
  /** Resolve the armed waiter (fed by the stdout / WS reader). */
  settle: (result: 'completed' | 'error', detail?: string) => void
  /** Stash the mod's structured per-op result; attached to the NEXT `settle('completed')`. */
  result: (data: Record<string, unknown>) => void
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
  // The latest structured per-op result the mod printed during the CURRENT op window.
  // Cleared on arm() so a non-result op never inherits a previous op's data.
  let pendingData: Record<string, unknown> | undefined

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
      pendingData = undefined
      return new Promise<SettleResult>((res) => {
        resolver = res
        timer = setTimeout(() => resolve({ result: 'timeout' }), timeoutMs)
      })
    },
    settle(result, detail) {
      // Attach any result stashed during this op window (only meaningful on 'completed').
      resolve({ result, detail, data: result === 'completed' ? pendingData : undefined })
    },
    result(data) {
      pendingData = data
    },
    cancel() {
      resolve({ result: 'cancelled' })
    },
  }
}

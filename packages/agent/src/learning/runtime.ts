import type { SettleBus } from './settle-bus'
import type { CraftPlan, EntityInfo, GameState, NearestResult, OpResult, Ops, RecipeInfo, ScanResult, SettleResult, TechInfo } from './types'
import * as vm from 'node:vm'
import { extractLastJsonLine } from './json'
import { CAPTURE_STATE_COMMAND, parseGameState, parseScan } from './state'

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Lets runSkill stop an orphaned (timed-out) skill at its next op, since
// Promise.race cannot actually interrupt a running vm execution.
const cancellers = new WeakMap<Ops, () => void>()

/** Serialise a JS value as a Lua literal for embedding inside a `remote.call`. */
export function luaArg(value: unknown): string {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '0'
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  // Order matters: escape backslashes first, then quotes, then literal newlines
  // (a raw \n in a Lua short-string literal is an "unfinished string" parse error).
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, '\\\'')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
  return `'${escaped}'`
}

// Operations that enqueue a task and therefore emit a settle signal when done.
// `research_technology` does NOT enqueue a task (it would never settle), and
// `craft_item` only settles when it returns success (it can reject synchronously).
const SETTLING_OPS = new Set(['walk_to_entity', 'mine_entity', 'place_entity', 'place_entity_at', 'move_items', 'wait', 'attack_nearest_enemy', 'craft_item'])

export interface OpsDeps {
  /** Send a full `/c ...` console command and resolve with the rcon output. */
  raw: (input: string) => Promise<string>
  settleBus: SettleBus
  /** Resolve `ops.skill(name, …)` against the skill library (wired in step 4). */
  runSkillByName?: (name: string, args: unknown[], ops: Ops) => Promise<OpResult>
  /** Hard cap on operations a single skill may issue (runaway guard). */
  maxOps?: number
}

/**
 * Build the closed `ops` capability surface. Each action sends ONE operation via
 * RCON, captures its Lua return value (to detect synchronous rejection), and —
 * for task-enqueuing ops — awaits the in-game settle before resolving.
 */
export function createOps(deps: OpsDeps): Ops {
  const logs: string[] = []
  const maxOps = deps.maxOps ?? 200
  let opCount = 0
  let cancelled = false

  function bumpOpCount() {
    opCount += 1
    if (opCount > maxOps) {
      throw new Error(`skill exceeded the ${maxOps}-operation limit (possible runaway loop)`)
    }
  }

  async function runOp(op: string, args: unknown[]): Promise<OpResult> {
    if (cancelled) {
      throw new Error('skill execution was cancelled (timed out)')
    }
    bumpOpCount()

    const settles = SETTLING_OPS.has(op)
    const argList = args.map(luaArg).join(',')
    const input = `/c local r={remote.call('autorio_operations','${op}',${argList})} local tj=helpers and helpers.table_to_json or game.table_to_json rcon.print(tj(r))`

    // Arm the settle waiter BEFORE dispatch so an immediate `[ERROR]` isn't missed.
    let settlePromise: Promise<SettleResult> | null = null
    if (settles) {
      settlePromise = deps.settleBus.arm()
    }

    let out: string
    try {
      out = await deps.raw(input)
    }
    catch (e) {
      if (settles) {
        deps.settleBus.cancel()
      }
      return { ok: false, error: `dispatch failed: ${errMsg(e)}` }
    }

    const ret = extractLastJsonLine<unknown[]>(out)
    // A non-array reply means the Lua errored (bad op/args) — fail fast.
    if (!Array.isArray(ret)) {
      if (settles) {
        deps.settleBus.cancel()
      }
      return { ok: false, error: (out && out.trim()) ? out.trim() : 'unexpected response from game' }
    }
    // The op rejected synchronously (e.g. craft: recipe locked / missing ingredients).
    if (ret[0] === false) {
      if (settles) {
        deps.settleBus.cancel()
      }
      return { ok: false, error: typeof ret[1] === 'string' ? ret[1] : 'operation rejected' }
    }

    // Fire-and-forget ops (research_technology) report success from the return value.
    if (!settles || !settlePromise) {
      return { ok: true, data: ret }
    }

    const settled = await settlePromise
    if (settled.result === 'completed') {
      return { ok: true }
    }
    if (settled.result === 'error') {
      return { ok: false, error: settled.detail ?? 'in-game error' }
    }
    if (settled.result === 'timeout') {
      return { ok: false, error: 'operation timed out' }
    }
    return { ok: false, error: 'operation was cancelled' }
  }

  const ops: Ops = {
    logs,
    log: (message: string) => {
      logs.push(String(message))
    },
    getState: async (): Promise<GameState> => {
      bumpOpCount()
      return parseGameState(await deps.raw(CAPTURE_STATE_COMMAND))
    },
    scan: async (radius = 32): Promise<ScanResult> => {
      bumpOpCount()
      const r = Math.max(1, Math.floor(radius))
      return parseScan(await deps.raw(`/c remote.call('autorio_tools','scan_area',${r})`))
    },
    getRecipe: async (name: string): Promise<RecipeInfo | null> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ recipe?: RecipeInfo }>(await deps.raw(`/c remote.call('autorio_tools','describe',${luaArg(name)})`))
      return (d && typeof d === 'object' && d.recipe) ? d.recipe : null
    },
    describeEntity: async (name: string): Promise<EntityInfo | null> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ entity?: EntityInfo }>(await deps.raw(`/c remote.call('autorio_tools','describe',${luaArg(name)})`))
      return (d && typeof d === 'object' && d.entity) ? d.entity : null
    },
    findNearest: async (name: string): Promise<NearestResult | null> => {
      bumpOpCount()
      const d = extractLastJsonLine<NearestResult>(await deps.raw(`/c remote.call('autorio_tools','find_nearest',${luaArg(name)})`))
      return (d && typeof d === 'object' && typeof d.x === 'number') ? d : null
    },
    craftPlan: async (item: string, count = 1): Promise<CraftPlan | null> => {
      bumpOpCount()
      const c = Math.max(1, Math.floor(count))
      const d = extractLastJsonLine<CraftPlan>(await deps.raw(`/c remote.call('autorio_tools','craft_plan',${luaArg(item)},${c})`))
      return (d && typeof d === 'object' && Array.isArray(d.steps)) ? d : null
    },
    techFor: async (item: string): Promise<TechInfo | null> => {
      bumpOpCount()
      const d = extractLastJsonLine<TechInfo>(await deps.raw(`/c remote.call('autorio_tools','tech_for',${luaArg(item)})`))
      return (d && typeof d === 'object' && typeof d.unlocked === 'boolean') ? d : null
    },
    usedIn: async (item: string): Promise<string[]> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ usedIn?: string[] }>(await deps.raw(`/c remote.call('autorio_tools','used_in',${luaArg(item)})`))
      return (d && Array.isArray(d.usedIn)) ? d.usedIn : []
    },
    walkToEntity: (entityName, searchRadius = 50) => runOp('walk_to_entity', [entityName, searchRadius]),
    mineEntity: (entityName, count = 1) => runOp('mine_entity', [entityName, count]),
    placeEntity: entityName => runOp('place_entity', [entityName]),
    placeAt: (entityName, at) => runOp('place_entity_at', [entityName, at.x, at.y, at.direction ?? 'north']),
    moveItems: ({ item, entity, maxCount = 999, toEntity = true }) => runOp('move_items', [item, entity, maxCount, toEntity]),
    craftItem: (recipe, count = 1) => runOp('craft_item', [recipe, count]),
    researchTechnology: technologyName => runOp('research_technology', [technologyName]),
    wait: ticks => runOp('wait', [ticks]),
    attackNearestEnemy: (searchRadius = 50) => runOp('attack_nearest_enemy', [searchRadius]),
    skill: async (name, ...args) => {
      if (!deps.runSkillByName) {
        return { ok: false, error: 'skill composition is not available yet (skill library not wired)' }
      }
      return deps.runSkillByName(name, args, ops)
    },
  }

  cancellers.set(ops, () => {
    cancelled = true
  })
  return ops
}

/**
 * Find the entry function: the LAST `async function name(…)` declaration, or
 * failing that the last `const/let/var name = async (…)` arrow. (Voyager-style:
 * the final async function is the entry point.)
 */
export function extractEntryName(source: string): string | null {
  // Single pass tracking brace depth so only TOP-LEVEL declarations are eligible
  // (a nested async helper must never be picked as the entry). The last top-level
  // async function / async arrow wins (Voyager convention). NOTE: braces inside
  // string/comment literals are not special-cased — fine for generated skill code.
  let depth = 0
  let lastTop: string | null = null
  let lastAny: string | null = null
  const re = /\{|\}|async\s+function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(source)) !== null) {
    if (m[0] === '{') {
      depth += 1
      continue
    }
    if (m[0] === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    const name = m[1] ?? m[2]
    lastAny = name
    if (depth === 0) {
      lastTop = name
    }
  }
  return lastTop ?? lastAny
}

export interface RunSkillResult {
  ok: boolean
  error?: string
  logs: string[]
}

export interface RunSkillOptions {
  timeoutMs?: number
}

/**
 * Compile and run LLM-generated skill code in a node:vm sandbox whose only
 * injected capabilities are `ops` (the closed vocabulary), a frozen `state`, and
 * a `console` that routes to `ops.log`. The bare vm context has its own
 * realm-isolated intrinsics (Object/Array/JSON/Math/Promise…) and crucially NO
 * Node globals — no `require`, `process`, `fs`, `fetch`, or `setTimeout`.
 *
 * Bounds: a wall-clock timeout here + an operation cap inside `createOps`.
 *
 * NOTE: node:vm guards against accidents and runaways, NOT a determined
 * adversary (a context can be escaped via shared prototypes). This is acceptable
 * because the code comes from the user's own model on their own machine — the
 * same trust model as Voyager running generated JS in a Node subprocess.
 */
export async function runSkill(source: string, ops: Ops, state: GameState, options: RunSkillOptions = {}): Promise<RunSkillResult> {
  const timeoutMs = options.timeoutMs ?? 120_000

  const name = extractEntryName(source)
  if (!name) {
    return { ok: false, error: 'no async function declaration found in the skill code', logs: ops.logs }
  }

  const sandbox: Record<string, unknown> = {
    ops,
    state: Object.freeze(state),
    console: {
      log: (...a: unknown[]) => ops.log(a.map(String).join(' ')),
      error: (...a: unknown[]) => ops.log(a.map(String).join(' ')),
    },
  }

  let context: vm.Context
  try {
    context = vm.createContext(sandbox)
    vm.runInContext(`${source}\n;globalThis.__entry = ${name}`, context, { timeout: 5000, filename: 'skill.js' })
  }
  catch (e) {
    return { ok: false, error: `compile error: ${errMsg(e)}`, logs: ops.logs }
  }

  const entry = sandbox.__entry
  if (typeof entry !== 'function') {
    return { ok: false, error: 'skill entry is not a function', logs: ops.logs }
  }

  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<RunSkillResult>((resolve) => {
    timer = setTimeout(() => {
      // Promise.race can't interrupt the vm — signal createOps so the orphaned
      // execution stops issuing real ops at its next await.
      cancellers.get(ops)?.()
      resolve({ ok: false, error: `skill timed out after ${timeoutMs}ms`, logs: ops.logs })
    }, timeoutMs)
  })

  try {
    const run = Promise.resolve((entry as (s: GameState, o: Ops) => unknown)(state, ops))
      .then<RunSkillResult>(() => ({ ok: true, logs: ops.logs }))
    // Swallow late rejections from an orphaned/cancelled run so they don't surface as unhandled.
    run.catch(() => {})
    return await Promise.race([run, timeout])
  }
  catch (e) {
    return { ok: false, error: `runtime error: ${errMsg(e)}`, logs: ops.logs }
  }
  finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

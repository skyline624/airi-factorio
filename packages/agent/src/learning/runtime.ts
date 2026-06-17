import type { SettleBus } from './settle-bus'
import type { CraftPlan, EntityInfo, GameState, MapView, NearestResult, OpResult, Ops, RecipeInfo, ScanResult, SettleResult, SteamPowerResult, TechInfo } from './types'
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
const SETTLING_OPS = new Set(['walk_to_entity', 'walk_to_position', 'mine_entity', 'place_entity_at', 'move_items', 'wait', 'attack_nearest_enemy', 'craft_item'])

/**
 * Per-session memo of the game's STATIC knowledge lookups, so the same recipe /
 * entity / craft-plan isn't re-fetched over RCON on every skill. `describe` is
 * prototype data (never changes); recipe/craftPlan/techFor/usedIn depend on the
 * force's RESEARCH state, so they're dropped whenever researchedCount rises
 * (`syncCacheEpoch`). NOT a substitute for the model's own reasoning — it only
 * removes redundant round-trips for facts that genuinely don't change.
 */
export interface GameDataCache {
  describe: Map<string, EntityInfo | null>
  recipe: Map<string, RecipeInfo | null>
  craftPlan: Map<string, CraftPlan | null>
  techFor: Map<string, TechInfo | null>
  usedIn: Map<string, string[]>
  /** researchedCount the research-dependent maps are valid for. */
  epoch: number
}

export function createGameDataCache(): GameDataCache {
  return { describe: new Map(), recipe: new Map(), craftPlan: new Map(), techFor: new Map(), usedIn: new Map(), epoch: -1 }
}

/** Research is monotonic: when researchedCount rises, recipe/plan/tech availability can change → drop those caches (keep the prototype-static `describe`). */
export function syncCacheEpoch(cache: GameDataCache, researchedCount: number): void {
  if (researchedCount > cache.epoch) {
    cache.epoch = researchedCount
    cache.recipe.clear()
    cache.craftPlan.clear()
    cache.techFor.clear()
    cache.usedIn.clear()
  }
}

export interface OpsDeps {
  /** Send a full `/c ...` console command and resolve with the rcon output. */
  raw: (input: string) => Promise<string>
  settleBus: SettleBus
  /** Resolve `ops.skill(name, …)` against the skill library (wired in step 4). */
  runSkillByName?: (name: string, args: unknown[], ops: Ops) => Promise<OpResult>
  /** Hard cap on operations a single skill may issue (runaway guard). */
  maxOps?: number
  /** Optional per-session cache of static knowledge lookups (recipe/entity/plan). */
  cache?: GameDataCache
}

/**
 * Build the closed `ops` capability surface. Each action sends ONE operation via
 * RCON, captures its Lua return value (to detect synchronous rejection), and —
 * for task-enqueuing ops — awaits the in-game settle before resolving.
 */
export function createOps(deps: OpsDeps): Ops {
  const logs: string[] = []
  const maxOps = deps.maxOps ?? 200
  const cache = deps.cache
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
      // For ops the mod reports on (e.g. placeAt -> {x,y,status}), surface the payload as data.
      return settled.data ? { ok: true, data: settled.data } : { ok: true }
    }
    if (settled.result === 'error') {
      return { ok: false, error: settled.detail ?? 'in-game error' }
    }
    if (settled.result === 'timeout') {
      // Name the op so a hang is identifiable in the logs/retry (the mod fast-fails most
      // stuck cases via [ERROR]; this settle timeout is the backstop for the rest).
      return { ok: false, error: `operation '${op}' timed out (the target may be unreachable — walk/scan and try a different spot)` }
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
      const s = parseGameState(await deps.raw(CAPTURE_STATE_COMMAND))
      // Keep the research-dependent cache fresh: a tech completing mid-session invalidates recipes.
      if (cache && typeof s.researchedCount === 'number') {
        syncCacheEpoch(cache, s.researchedCount)
      }
      return s
    },
    scan: async (radius = 32): Promise<ScanResult> => {
      bumpOpCount()
      const r = Math.max(1, Math.floor(radius))
      return parseScan(await deps.raw(`/c remote.call('autorio_tools','scan_area',${r})`))
    },
    getRecipe: async (name: string): Promise<RecipeInfo | null> => {
      bumpOpCount()
      if (cache && cache.recipe.has(name)) {
        return cache.recipe.get(name) ?? null
      }
      const d = extractLastJsonLine<{ recipe?: RecipeInfo }>(await deps.raw(`/c remote.call('autorio_tools','describe',${luaArg(name)})`))
      const result = (d && typeof d === 'object' && d.recipe) ? d.recipe : null
      cache?.recipe.set(name, result)
      return result
    },
    describeEntity: async (name: string): Promise<EntityInfo | null> => {
      bumpOpCount()
      if (cache && cache.describe.has(name)) {
        return cache.describe.get(name) ?? null
      }
      const d = extractLastJsonLine<{ entity?: EntityInfo }>(await deps.raw(`/c remote.call('autorio_tools','describe',${luaArg(name)})`))
      const result = (d && typeof d === 'object' && d.entity) ? d.entity : null
      cache?.describe.set(name, result)
      return result
    },
    findNearest: async (name: string): Promise<NearestResult | null> => {
      bumpOpCount()
      const d = extractLastJsonLine<NearestResult>(await deps.raw(`/c remote.call('autorio_tools','find_nearest',${luaArg(name)})`))
      return (d && typeof d === 'object' && typeof d.x === 'number') ? d : null
    },
    craftPlan: async (item: string, count = 1): Promise<CraftPlan | null> => {
      bumpOpCount()
      const c = Math.max(1, Math.floor(count))
      const key = `${item}|${c}`
      if (cache && cache.craftPlan.has(key)) {
        return cache.craftPlan.get(key) ?? null
      }
      const d = extractLastJsonLine<CraftPlan>(await deps.raw(`/c remote.call('autorio_tools','craft_plan',${luaArg(item)},${c})`))
      const result = (d && typeof d === 'object' && Array.isArray(d.steps)) ? d : null
      cache?.craftPlan.set(key, result)
      return result
    },
    techFor: async (item: string): Promise<TechInfo | null> => {
      bumpOpCount()
      if (cache && cache.techFor.has(item)) {
        return cache.techFor.get(item) ?? null
      }
      const d = extractLastJsonLine<TechInfo>(await deps.raw(`/c remote.call('autorio_tools','tech_for',${luaArg(item)})`))
      const result = (d && typeof d === 'object' && typeof d.unlocked === 'boolean') ? d : null
      cache?.techFor.set(item, result)
      return result
    },
    usedIn: async (item: string): Promise<string[]> => {
      bumpOpCount()
      if (cache && cache.usedIn.has(item)) {
        return cache.usedIn.get(item) ?? []
      }
      const d = extractLastJsonLine<{ usedIn?: string[] }>(await deps.raw(`/c remote.call('autorio_tools','used_in',${luaArg(item)})`))
      const result = (d && Array.isArray(d.usedIn)) ? d.usedIn : []
      cache?.usedIn.set(item, result)
      return result
    },
    productionStats: async (): Promise<{ produced: Record<string, number>, consumed: Record<string, number> } | null> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ produced?: Record<string, number>, consumed?: Record<string, number> }>(await deps.raw(`/c remote.call('autorio_tools','production_stats')`))
      return (d && typeof d === 'object' && d.produced) ? { produced: d.produced, consumed: d.consumed ?? {} } : null
    },
    renderMap: async (radius = 16, center?: { x: number, y: number }): Promise<MapView | null> => {
      bumpOpCount()
      const cx = (center !== undefined && typeof center.x === 'number') ? `${Math.floor(center.x)}` : 'nil'
      const cy = (center !== undefined && typeof center.y === 'number') ? `${Math.floor(center.y)}` : 'nil'
      const rad = Math.max(1, Math.floor(radius))
      const d = extractLastJsonLine<MapView>(await deps.raw(`/c remote.call('autorio_tools','render_map',${cx},${cy},${rad})`))
      return (d && typeof d === 'object' && Array.isArray(d.grid)) ? d : null
    },
    placementSpots: async (name, near, radius = 8, direction = 'north') => {
      bumpOpCount()
      const cx = (near && typeof near.x === 'number') ? `${Math.floor(near.x)}` : 'nil'
      const cy = (near && typeof near.y === 'number') ? `${Math.floor(near.y)}` : 'nil'
      const rad = Math.max(1, Math.floor(radius))
      const d = extractLastJsonLine<{ spots?: Array<{ x: number, y: number }> }>(await deps.raw(`/c remote.call('autorio_tools','placement_spots',${luaArg(name)},${cx},${cy},${rad},${luaArg(direction)})`))
      return (d && Array.isArray(d.spots)) ? { spots: d.spots } : { spots: [] }
    },
    walkToEntity: (entityName, searchRadius = 50) => runOp('walk_to_entity', [entityName, searchRadius]),
    walkTo: (x, y) => runOp('walk_to_position', [x, y]),
    mineEntity: (entityName, count = 1) => runOp('mine_entity', [entityName, count]),
    placeAt: (entityName, at) => {
      // No silent default to (0,0): the model MUST pass explicit coordinates read off
      // renderMap. A missing/NaN x or y is a mistake, not a spawn-point placement.
      if (at === undefined || typeof at.x !== 'number' || typeof at.y !== 'number' || Number.isNaN(at.x) || Number.isNaN(at.y)) {
        return Promise.resolve({ ok: false, error: 'placeAt needs explicit numeric x and y read from renderMap (it will not default to 0,0)' })
      }
      return runOp('place_entity_at', [entityName, at.x, at.y, at.direction ?? 'north'])
    },
    placeDrillOn: async (resource: string, drillName = 'burner-mining-drill'): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, mining?: string }>(await deps.raw(`/c remote.call('autorio_tools','place_drill_on',${luaArg(resource)},${luaArg(drillName)})`))
      return (d && d.ok === true) ? { ok: true, data: { mining: d.mining } } : { ok: false, error: (d && d.error) ? d.error : 'place_drill_on failed' }
    },
    placeFurnaceAtDrill: async (furnaceName = 'stone-furnace'): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, reclaimed?: number }>(await deps.raw(`/c remote.call('autorio_tools','place_furnace_at_drill',${luaArg(furnaceName)})`))
      return (d && d.ok === true) ? { ok: true, data: { reclaimed: d.reclaimed ?? 0 } } : { ok: false, error: (d && d.error) ? d.error : 'place_furnace_at_drill failed' }
    },
    placeBeltLine: async (startX: number, startY: number, endX: number, endY: number, beltName = 'transport-belt'): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, placed?: number, reused?: number, blocked?: Array<{ x: number, y: number }> }>(
        await deps.raw(`/c remote.call('autorio_tools','place_belt_line',${startX},${startY},${endX},${endY},${luaArg(beltName)})`),
      )
      if (!d || typeof d !== 'object') {
        return { ok: false, error: 'place_belt_line failed' }
      }
      const blocked = Array.isArray(d.blocked) ? d.blocked : []
      const data = { placed: d.placed ?? 0, reused: d.reused ?? 0, blocked }
      if (d.ok === true) {
        return { ok: true, data }
      }
      const where = blocked.length > 0 ? ` (blocked at ${blocked.map(t => `(${t.x},${t.y})`).join(', ')})` : ''
      return { ok: false, error: (d.error ?? `belt line incomplete: placed ${data.placed}, ${blocked.length} tile(s) blocked`) + where, data }
    },
    placeInserterBetween: async (fromName: string, toName: string, inserterName = 'burner-inserter'): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string }>(await deps.raw(`/c remote.call('autorio_tools','place_inserter_between',${luaArg(fromName)},${luaArg(toName)},${luaArg(inserterName)})`))
      return (d && d.ok === true) ? { ok: true } : { ok: false, error: (d && d.error) ? d.error : 'place_inserter_between failed' }
    },
    connect: async (startX: number, startY: number, endX: number, endY: number, kind = 'belt', name?: string): Promise<OpResult> => {
      bumpOpCount()
      const nameArg = (name && name.length) ? luaArg(name) : 'nil'
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, placed?: number, reused?: number, blocked?: Array<{ x: number, y: number }> }>(
        await deps.raw(`/c remote.call('autorio_tools','connect_entities',${startX},${startY},${endX},${endY},${luaArg(kind)},${nameArg})`),
      )
      if (!d || typeof d !== 'object') {
        return { ok: false, error: 'connect failed' }
      }
      const blocked = Array.isArray(d.blocked) ? d.blocked : []
      const data = { placed: d.placed ?? 0, reused: d.reused ?? 0, blocked }
      if (d.ok === true) {
        return { ok: true, data }
      }
      const where = blocked.length > 0 ? ` (blocked at ${blocked.map(t => `(${t.x},${t.y})`).join(', ')})` : ''
      return { ok: false, error: (d.error ?? `connection incomplete: placed ${data.placed}, ${blocked.length} tile(s) blocked`) + where, data }
    },
    placeNextTo: async (entity: string, targetName: string, side?: string): Promise<OpResult> => {
      bumpOpCount()
      const sideArg = (side && side.length) ? luaArg(side) : 'nil'
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, x?: number, y?: number, status?: string }>(await deps.raw(`/c remote.call('autorio_tools','place_next_to',${luaArg(entity)},${luaArg(targetName)},${sideArg})`))
      return (d && d.ok === true) ? { ok: true, data: { x: d.x, y: d.y, status: d.status } } : { ok: false, error: (d && d.error) ? d.error : 'place_next_to failed' }
    },
    moveItems: ({ item, entity, maxCount = 999, toEntity = true }) => runOp('move_items', [item, entity, maxCount, toEntity]),
    craftItem: (recipe, count = 1) => runOp('craft_item', [recipe, count]),
    setRecipe: async (recipe: string): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string }>(await deps.raw(`/c remote.call('autorio_tools','set_recipe',${luaArg(recipe)})`))
      return (d && d.ok === true) ? { ok: true } : { ok: false, error: (d && d.error) ? d.error : 'set_recipe failed' }
    },
    buildSteamPower: async (): Promise<SteamPowerResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<SteamPowerResult>(await deps.raw(`/c remote.call('autorio_tools','build_steam_power')`))
      return (d && typeof d === 'object' && typeof d.ok === 'boolean') ? d : { ok: false, error: 'build_steam_power failed (no/invalid response)' }
    },
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

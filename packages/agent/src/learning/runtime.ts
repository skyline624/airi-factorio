import type { SettleBus } from './settle-bus'
import type { CraftPlan, EntityDetail, EntityInfo, GameState, MapView, NearestResult, OpResult, Ops, RecipeInfo, ScanResult, SettleResult, SteamPowerResult, TechInfo } from './types'
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
  if (Array.isArray(value)) {
    return `{${value.map(luaArg).join(',')}}`
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
    scanFactory: async (): Promise<ScanResult> => {
      bumpOpCount()
      return parseScan(await deps.raw(`/c remote.call('autorio_tools','scan_factory')`))
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
    getEntity: async (at: { x: number, y: number }): Promise<EntityDetail | null> => {
      bumpOpCount()
      if (at === undefined || typeof at.x !== 'number' || typeof at.y !== 'number' || Number.isNaN(at.x) || Number.isNaN(at.y)) {
        return null
      }
      const d = extractLastJsonLine<EntityDetail>(await deps.raw(`/c remote.call('autorio_tools','get_entity',${Math.floor(at.x)},${Math.floor(at.y)})`))
      return (d && typeof d === 'object' && typeof d.name === 'string') ? d : null
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
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, mining?: string, x?: number, y?: number }>(await deps.raw(`/c remote.call('autorio_tools','place_drill_on',${luaArg(resource)},${luaArg(drillName)})`))
      return (d && d.ok === true) ? { ok: true, data: { mining: d.mining, x: d.x, y: d.y } } : { ok: false, error: (d && d.error) ? d.error : 'place_drill_on failed' }
    },
    placeFurnaceAtDrill: async (furnaceName = 'stone-furnace'): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, reclaimed?: number }>(await deps.raw(`/c remote.call('autorio_tools','place_furnace_at_drill',${luaArg(furnaceName)})`))
      return (d && d.ok === true) ? { ok: true, data: { reclaimed: d.reclaimed ?? 0 } } : { ok: false, error: (d && d.error) ? d.error : 'place_furnace_at_drill failed' }
    },
    placeChestAtDrill: async (chestName = 'wooden-chest'): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, chest?: string, x?: number, y?: number, reclaimed?: number }>(await deps.raw(`/c remote.call('autorio_tools','place_chest_at_drill',${luaArg(chestName)})`))
      return (d && d.ok === true) ? { ok: true, data: { chest: d.chest, x: d.x, y: d.y, reclaimed: d.reclaimed ?? 0 } } : { ok: false, error: (d && d.error) ? d.error : 'place_chest_at_drill failed' }
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
    // High-level composite primitives. Each bundles the walk / prerequisites / arithmetic the
    // model kept getting wrong (craft one pipe instead of three; moveItems out of reach; act
    // without holding the item). They only ORCHESTRATE existing ops — the model still decides
    // WHAT to craft/fuel/collect; these just make the mechanical HOW reliable. Not settling
    // themselves (the sub-ops settle); the op cap is enforced by the sub-ops' bumpOpCount.
    craftAll: async (item: string, count = 1): Promise<OpResult> => {
      const have0 = (await ops.getState()).inventory[item] ?? 0
      if (have0 >= count) {
        return { ok: true, data: { alreadyHad: have0 } }
      }
      const plan = await ops.craftPlan(item, count)
      if (!plan) {
        return { ok: false, error: `craftAll: no recipe for '${item}'` }
      }
      if (plan.locked && plan.locked.length) {
        return { ok: false, error: `craftAll: '${item}' needs research first (locked: ${plan.locked.join(', ')}). Research it, then retry.` }
      }
      // Craft the intermediate chain leaves-first. A 'smelting' step can't be hand-crafted (a
      // furnace makes it) — if we're short, fail with a clear "smelt it first" message.
      for (const step of plan.steps) {
        if (step.name === item) {
          continue
        }
        const cur = (await ops.getState()).inventory[step.name] ?? 0
        if (cur >= step.amount) {
          continue
        }
        if (step.category === 'smelting') {
          return { ok: false, error: `craftAll: need ${step.amount}x '${step.name}' (smelted, not hand-craftable) — build a furnace to make it and collect from its output, then retry. Have ${cur}.` }
        }
        const r = await ops.craftItem(step.name, step.amount - cur)
        if (!r.ok) {
          return { ok: false, error: `craftAll: failed crafting ${step.amount - cur}x '${step.name}': ${r.error}` }
        }
      }
      // Craft the final item (shortfall vs what we already hold).
      const haveNow = (await ops.getState()).inventory[item] ?? 0
      if (haveNow < count) {
        const r = await ops.craftItem(item, count - haveNow)
        if (!r.ok) {
          return { ok: false, error: `craftAll: failed crafting '${item}': ${r.error}` }
        }
      }
      const final = (await ops.getState()).inventory[item] ?? 0
      return final >= count ? { ok: true, data: { crafted: final } } : { ok: false, error: `craftAll: only have ${final}/${count} '${item}' after crafting` }
    },
    ensure: async (item: string, count = 1): Promise<OpResult> => {
      const have = (await ops.getState()).inventory[item] ?? 0
      if (have >= count) {
        return { ok: true, data: { had: have } }
      }
      // Craftable (has an enabled recipe) -> craftAll. Otherwise it's a raw resource -> mine it.
      const recipe = await ops.getRecipe(item)
      if (recipe && recipe.enabled) {
        return ops.craftAll(item, count)
      }
      const walk = await ops.walkToEntity(item, 300)
      if (!walk.ok) {
        // Tile-based resource (e.g. a spot with no entity) — reach it via findNearest/walkTo.
        const near = await ops.findNearest(item)
        if (!near) {
          return { ok: false, error: `ensure: '${item}' is neither craftable nor a reachable resource` }
        }
        await ops.walkTo(near.x, near.y)
      }
      // mineEntity's count is an ABSOLUTE threshold ("mine until you HOLD count"), not a delta —
      // the mod-side loop (control.ts MINING) breaks when inv.get_item_count >= count. So pass the
      // absolute `count`, NOT `need` (count-have): passing need with have>0 mined until inv=need
      // (< count) and ensure failed "only have need/count" — the latent bug the coal-25 bump exposed.
      const mined = await ops.mineEntity(item, count)
      if (!mined.ok) {
        return { ok: false, error: `ensure: failed mining '${item}': ${mined.error}` }
      }
      const final = (await ops.getState()).inventory[item] ?? 0
      return final >= count ? { ok: true, data: { got: final } } : { ok: false, error: `ensure: only have ${final}/${count} '${item}' after mining` }
    },
    fuel: async (entityName: string, item = 'coal', amount = 5): Promise<OpResult> => {
      // Guarantee we hold the fuel first (the #1 fuelling failure was an empty hand).
      const have = (await ops.getState()).inventory[item] ?? 0
      if (have < amount) {
        const got = await ops.ensure(item, amount)
        if (!got.ok) {
          return { ok: false, error: `fuel: could not obtain ${amount}x '${item}': ${got.error}` }
        }
      }
      const walk = await ops.walkToEntity(entityName, 50)
      if (!walk.ok) {
        return { ok: false, error: `fuel: could not reach '${entityName}': ${walk.error}` }
      }
      const moved = await ops.moveItems({ item, entity: entityName, maxCount: amount, toEntity: true })
      if (!moved.ok) {
        return { ok: false, error: `fuel: could not load '${item}' into '${entityName}': ${moved.error}` }
      }
      return { ok: true }
    },
    fuelAt: async (entityName: string, at: { x: number, y: number }, item = 'coal', amount = 5): Promise<OpResult> => {
      // Fuel the SPECIFIC machine at `at` (the one just placed), not the nearest. `move_items` is
      // player-centred radius 32 with NO distance priority — it iterates same-name machines in
      // spatial order and caps the load TOTAL, so when a second same-name machine is within 32 (e.g.
      // the iron drill while fuelling the just-placed coal drill, ~24 tiles away) the fuel SPLIT
      // across both and the new machine got 0 → the rung stalled ("produce coal +0"). Walk to the
      // target, then step AWAY from the nearest other same-name machine so only the target is within
      // the 32-tile search, then moveItems.
      const have = (await ops.getState()).inventory[item] ?? 0
      if (have < amount) {
        const got = await ops.ensure(item, amount)
        if (!got.ok) {
          return { ok: false, error: `fuelAt: could not obtain ${amount}x '${item}': ${got.error}` }
        }
      }
      await ops.walkTo(at.x, at.y)
      // Exclude other same-name machines from the radius-32 search by walking the player past the
      // 32-tile boundary that separates the target from its nearest neighbour.
      const scan = await ops.scanFactory()
      const others = scan.entities.filter(e => e.name === entityName && (Math.abs(e.x - at.x) > 0.5 || Math.abs(e.y - at.y) > 0.5))
      if (others.length > 0) {
        let nearest = others[0]
        let nd = Infinity
        for (const o of others) {
          const d = (o.x - at.x) ** 2 + (o.y - at.y) ** 2
          if (d < nd) {
            nd = d
            nearest = o
          }
        }
        const otherDist = Math.sqrt(nd)
        if (otherDist < 32) {
          // Direction from the other machine toward the target (walk the player that way to leave
          // the other behind the 32 boundary). Walk far enough that the OTHER's bounding box (a 2x2
          // drill/furnace adds ~1 tile) is >32 from the player (otherDist + walkDist > 33), but stay
          // <32 from the target so moveItems still finds it (walkDist < 32). 14 was too short (coal
          // drill 12 from the iron drill → the iron's 2x2 box at distance 33 was still swept → split
          // gave the coal drill only ~2 coal → it mined 2 then ran out → "produced coal +2"). Use
          // 38 - otherDist for a clear margin; cap at 30 so the target stays within 32.
          const walkDist = Math.min(30, Math.max(14, 38 - otherDist))
          const dx = at.x - nearest.x
          const dy = at.y - nearest.y
          const len = Math.hypot(dx, dy) || 1
          const px = Math.round(at.x + (dx / len) * walkDist)
          const py = Math.round(at.y + (dy / len) * walkDist)
          await ops.walkTo(px, py)
        }
      }
      const moved = await ops.moveItems({ item, entity: entityName, maxCount: amount, toEntity: true })
      if (!moved.ok) {
        return { ok: false, error: `fuelAt: could not load '${item}' into '${entityName}' at (${at.x},${at.y}): ${moved.error}` }
      }
      return { ok: true }
    },
    collectOutput: async (entityName: string, item?: string): Promise<OpResult> => {
      const walk = await ops.walkToEntity(entityName, 50)
      if (!walk.ok) {
        return { ok: false, error: `collectOutput: could not reach '${entityName}': ${walk.error}` }
      }
      // Determine what to take. If unspecified, read the machine's output slots via getEntity.
      let items: string[] = item ? [item] : []
      if (!item) {
        const scan = await ops.scan(12)
        const e = scan.entities.find(en => en.name === entityName || en.type === entityName)
        if (e) {
          const detail = await ops.getEntity({ x: e.x, y: e.y })
          if (detail && detail.output) {
            items = detail.output.map(o => o.name)
          }
        }
      }
      if (!items.length) {
        return { ok: false, error: `collectOutput: nothing to collect from '${entityName}' (no output items — smelt/produce first)` }
      }
      let collected = 0
      for (const it of items) {
        const r = await ops.moveItems({ item: it, entity: entityName, maxCount: 999, toEntity: false })
        if (r.ok) {
          collected += 1
        }
      }
      return collected > 0 ? { ok: true, data: { collected: items } } : { ok: false, error: `collectOutput: could not extract from '${entityName}'` }
    },
    connectPowerTo: async (targetName: string, poleName = 'small-electric-pole'): Promise<OpResult> => {
      // Wire the nearest steam-engine to the nearest `targetName` machine with a pole line.
      // Composes existing ops: scan (locate both) -> ensure (guarantee a pole in hand) -> connect
      // (lay the auto-spaced pole line). This is the fix for an engine stuck not_plugged_in / a
      // machine reading no_power. The mod computes wire spacing; we just supply the endpoints.
      const scan = await ops.scan(60)
      const engine = scan.entities.find(e => e.name === 'steam-engine' || e.type === 'generator')
      if (!engine) {
        return { ok: false, error: 'connectPowerTo: no steam-engine nearby — build steam power first (buildSteamPower)' }
      }
      const target = scan.entities.find(e => e.name === targetName || e.type === targetName)
      if (!target) {
        return { ok: false, error: `connectPowerTo: no '${targetName}' nearby to power` }
      }
      // Guarantee we hold a pole (craft it from copper-plate + wood if needed). Needs copper
      // automated first — else this fails clearly instead of a cryptic "no pole in inventory".
      const got = await ops.ensure(poleName, 1)
      if (!got.ok) {
        return { ok: false, error: `connectPowerTo: could not obtain a '${poleName}' (needs copper-plate + wood — automate copper first): ${got.error}` }
      }
      const wired = await ops.connect(engine.x, engine.y, target.x, target.y, 'power', poleName)
      if (!wired.ok) {
        return { ok: false, error: `connectPowerTo: failed to wire '${targetName}': ${wired.error}`, data: wired.data }
      }
      return { ok: true, data: { engine: { x: engine.x, y: engine.y }, target: { x: target.x, y: target.y } } }
    },
    automateResource: async (resource: string, drillName = 'burner-mining-drill'): Promise<OpResult> => {
      // Full auto-mining chain in one call: drill on the patch -> the RIGHT output (a FURNACE for
      // a smeltable ore, else a CHEST for coal/stone/etc.) -> fuel everything. Composes existing
      // ops. Coal especially MUST be automated early — it fuels every burner machine, and
      // hand-mining it forever is why the factory stalls. iron-ore/copper-ore smelt into a plate;
      // everything else (coal, stone, uranium-ore, …) is already-finished -> a chest.
      const SMELTS_TO: Record<string, string> = { 'iron-ore': 'iron-plate', 'copper-ore': 'copper-plate' }
      const plate = SMELTS_TO[resource]

      // Obtain the drill's output item and return the NAME we managed to get. A smeltable ore needs a
      // furnace; coal/stone need a CHEST — but wooden-chest costs 2 wood, which is UNAVAILABLE on a
      // desert map (dead trees give none). So fall back to iron-chest (8 iron-plate, and iron is the
      // first thing automated). Returns null if none can be obtained → caller fails with guidance.
      const ensureOutput = async (count: number): Promise<string | null> => {
        if (plate) {
          return (await ops.ensure('stone-furnace', count)).ok ? 'stone-furnace' : null
        }
        for (const chest of ['wooden-chest', 'iron-chest']) {
          if ((await ops.ensure(chest, count)).ok) {
            return chest
          }
        }
        return null
      }
      const noOutputErr = plate
        ? `automateResource: could not obtain a stone-furnace for '${resource}'`
        : `automateResource: could not obtain a chest for '${resource}' — a wooden-chest needs 2 wood (none on desert maps) and an iron-chest needs 8 iron-plate; collect 8 iron-plate from a furnace first, then retry`

      // FUEL FIRST: guarantee ~10 coal in hand BEFORE placing anything. Burning fuel for a drill
      // comes from coal; if we run `fuel` AFTER placeDrillOn, its `ensure('coal')` would walk to the
      // nearest coal — which is the patch UNDER the drill we just placed — and `mineEntity` would
      // DESTROY that drill (the bug we're fixing). Doing it up front mines a BARE patch (find_nearest
      // is now drill-aware) and leaves coal in hand so `fuel` short-circuits without hand-mining.
      // [FIX 1] Production baseline + post-place poll. The produce successCheck reads the FORCE
      // production counter at attempt end; automateResource used to return right after placing+
      // fueling (~0.4s), before any plate/coal was smelted/mined → +0 → FAIL (the "produce
      // iron-plate +0" wall). The chain works — it produced 92 plates once left to run (confirmed
      // via production_stats) — it just needs time. Poll until the chain produces `target` of the
      // output item (the plate for iron/copper, the raw resource for coal/stone), then return so the
      // deterministic critic sees real output. 45×60 ticks ≈ 45 s (a plate smelts in ~3.5 s, a drill
      // mines ~0.25 ore/s, so 3 is well within budget). target=3 matches the roadmap's produce-3
      // successChecks; if the chain is too slow to make 3, the rung SHOULD fail.
      const produceItem = plate ?? resource
      const producedNow = async (): Promise<number> => (((await ops.productionStats())?.produced) ?? {})[produceItem] ?? 0
      const prodStart = await producedNow()
      // Poll target/timeout by output kind. A SMELTABLE rung (iron/copper) should smelt enough
      // plates to feed the NEXT rung's drill (recipe = 9 iron-plate): poll to 6 (the successCheck
      // floor is +3; the furnace keeps smelting past the poll break, so its output holds a batch the
      // next rung can collectOutput). A raw rung (coal/stone) just verifies the drill produces, so
      // target=3. 60×60 ticks ≈ 60 s for smeltable; 45×60 for raw. If the chain can't reach the
      // target in time, the rung still PASSES at +3 (the successCheck floor).
      const pollTarget = plate ? 6 : 3
      const pollIters = plate ? 60 : 45
      const waitForOutput = async (): Promise<void> => {
        for (let i = 0; i < pollIters; i++) {
          await ops.wait(60)
          const got = await producedNow()
          if (i % 5 === 0) {
            ops.log(`automateResource(${resource}): poll ${i} ${produceItem} produced=${got} (need +${pollTarget} from baseline ${prodStart})`)
          }
          if (got - prodStart >= pollTarget) {
            return
          }
        }
        ops.log(`automateResource(${resource}): poll timed out — ${produceItem} reached ${await producedNow()} (baseline ${prodStart}, need +${pollTarget})`)
      }
      // FUEL UP FRONT: 15 coal so a smeltable rung can fuel its drill (5) AND its furnace (10). The
      // furnace burns ~1.1 plate/coal (measured), so 10 coal smelts ~12 plates — enough for the
      // next rung's drill (9 plates) + margin. A raw rung only fuels its drill (5), so 15 is plenty.
      if (((await ops.getState()).inventory['coal'] ?? 0) < 15) {
        const gotCoal = await ops.ensure('coal', 15)
        if (!gotCoal.ok) {
          return { ok: false, error: `automateResource: could not bootstrap 15 coal for fuel (a bare coal patch with no drill on it is needed): ${gotCoal.error}` }
        }
      }

      // REACH the patch first. findNearest searches 400 tiles (vs walkToEntity's 200), so a distant
      // patch (the common coal case — the player wandered off) is still reachable.
      const near = await ops.findNearest(resource)
      const walk = near ? await ops.walkTo(near.x, near.y) : await ops.walkToEntity(resource, 200)
      if (!walk.ok) {
        return { ok: false, error: `automateResource: could not reach '${resource}': ${walk.error}` }
      }

      // IDEMPOTENCY: is a drill ALREADY mining this resource here? If so, REPAIR it (add output +
      // fuel) instead of placing another — placeDrillOn is NOT idempotent (the mod stacks a new
      // drill beside the patch each call), which is why re-proposing "Automate copper" piled up 4
      // drills. Repair, don't rebuild.
      // [FIX 3] Use the force-wide census (scanFactory), NOT a player-centred scan(32). A retry runs
      // after the player mined coal (off the resource patch), so scan(32) around the player missed
      // the placed drill → the retry re-crafted a drill instead of repairing → "need 9x iron-plate,
      // have 3". The census sees the player's machines anywhere on the surface, with their `mining`.
      const scan = await ops.scanFactory()
      const existing = scan.entities.filter(e => e.type === 'mining-drill' && e.mining === resource)
      ops.log(`automateResource(${resource}): census found ${existing.length} existing drill(s) on ${resource}`)
      if (existing.length > 0) {
        // Best-effort output: obtain output items (furnace/chest) for drills that still LACK one.
        // placeFurnaceAtDrill/placeChestAtDrill are idempotent — a drill that already has its output
        // is skipped (no item consumed) and a misplaced one reclaimed — so DON'T fail the rung if
        // ensureOutput can't get an item (e.g. no stone to craft a furnace): drills that already
        // have an output still get re-FUELED below, and a lacking drill is logged + skipped.
        const outputItem = await ensureOutput(existing.length)
        // placeFurnaceAtDrill/placeChestAtDrill target the NEAREST drill — walk to each in turn so
        // every stacked drill gets its output. Best-effort: a single-drill failure doesn't abort.
        for (const d of existing) {
          await ops.walkTo(d.x, d.y)
          const outName = outputItem ?? (plate ? 'stone-furnace' : 'wooden-chest')
          const out = plate ? await ops.placeFurnaceAtDrill(outName) : await ops.placeChestAtDrill(outName)
          if (!out.ok) {
            ops.log(`automateResource: repair — output for drill @${d.x},${d.y} failed: ${out.error}`)
          }
        }
        // Re-fuel the existing drill(s) + furnace. This is the core repair: a no_fuel drill/furnace
        // is the usual reason the chain stalled on the prior attempt (it placed + fueled but the
        // one-shot fuel burned out, or the fuel op split across drills). fuelAt targets each drill
        // at its own position so the coal isn't split with a neighbouring drill.
        for (const d of existing) {
          await ops.fuelAt('burner-mining-drill', { x: d.x, y: d.y }, 'coal', 5).catch(() => {})
        }
        if (plate) {
          await ops.fuel('stone-furnace', 'coal', 10 * existing.length)
        }
        await waitForOutput()
        return { ok: true, data: { resource, repaired: existing.length, output: plate ? 'furnace' : 'chest' } }
      }

      // BUILD (nothing here yet). Guarantee we HOLD the drill AND its output BEFORE placing —
      // placeDrillOn/placeChestAtDrill consume from the inventory and fail if empty. ensure crafts
      // the drill (iron+gears); the output is picked/obtained by ensureOutput (furnace or a chest).
      // [FIX 2] The drill recipe is 3 iron-plate + 3 iron-gear-wheel (6 plate) + 1 stone-furnace
      // (5 stone) = 9 iron-plate + 5 stone in hand. After a prior rung PLACED its drill, 0 drills +
      // 0 furnaces remain and the smelted plates sit in the iron chain's furnace OUTPUT (not the
      // hand); stone was spent in bootstrap. Gather both BEFORE ensure(drill) so its craftAll
      // leaves-first doesn't fail on a missing leaf ("need 9x iron-plate (smelted, not
      // hand-craftable)" / missing stone) — the exact cascade that sent the iron rung to open mode.
      // Skipped when a drill is already held (the bootstrap rung holds the drill it just crafted).
      const preBuild = (await ops.getState()).inventory
      if ((preBuild[drillName] ?? 0) < 1) {
        if ((preBuild['iron-plate'] ?? 0) < 9) {
          // Pull iron-plate from the existing iron chain's furnace output (best-effort: on the very
          // first rung the agent holds the bootstrap drill, so this block is skipped; a no-furnace
          // collectOutput fails harmlessly and ensure(drill) then relies on the held stock).
          await ops.collectOutput('stone-furnace', 'iron-plate').catch(() => {})
        }
        if (((await ops.getState()).inventory['stone'] ?? 0) < 5) {
          const gs = await ops.ensure('stone', 5)
          if (!gs.ok) {
            return { ok: false, error: `automateResource: could not obtain 5 stone for the drill's furnace: ${gs.error}` }
          }
        }
      }
      const haveDrill = await ops.ensure(drillName, 1)
      if (!haveDrill.ok) {
        return { ok: false, error: `automateResource: could not obtain a '${drillName}': ${haveDrill.error}` }
      }
      // The drill's output item: a FURNACE for a smeltable ore (iron/copper — else no plates), or
      // a CHEST for a raw ore (coal/stone — to collect it). The furnace is REQUIRED (no furnace → no
      // smelting → the rung can't pass). The chest is OPTIONAL: a raw-ore drill increments the
      // production counter whether the ore drops into a chest or on the ground, so the produce
      // successCheck passes either way — and a wooden-chest needs 2 wood (none on a desert map) +
      // an iron-chest needs 8 iron-plate (which the coal rung doesn't have after crafting its drill),
      // so demanding one blocked coal ("could not obtain a chest"). Best-effort the chest; the furnace
      // stays mandatory.
      const outputItem = await ensureOutput(1)
      if (plate && !outputItem) {
        return { ok: false, error: noOutputErr }
      }
      const drill = await ops.placeDrillOn(resource, drillName)
      if (!drill.ok) {
        return { ok: false, error: `automateResource: could not seat a drill on '${resource}': ${drill.error}` }
      }
      // Stand on the drill we JUST placed before adding its output: placeFurnaceAtDrill/
      // placeChestAtDrill target the drill NEAREST the player, so with other drills clustered nearby
      // (e.g. a copper drill next to the new coal drill) the output would otherwise land on the wrong
      // drill's drop tile. Walk onto the new drill so it is unambiguously the nearest.
      const dp = drill.data as { mining?: string, x?: number, y?: number } | undefined
      if (dp && typeof dp.x === 'number' && typeof dp.y === 'number') {
        await ops.walkTo(dp.x, dp.y)
      }
      // Place the output item if we have one. For a raw ore with no chest, skip — the drill drops on
      // the ground and production still counts (the successCheck reads the production counter).
      const output: OpResult = outputItem
        ? (plate ? await ops.placeFurnaceAtDrill(outputItem) : await ops.placeChestAtDrill(outputItem))
        : { ok: true, data: { note: 'raw ore drops on the ground (no chest available — production still counts)' } }
      if (!output.ok) {
        return { ok: false, error: `automateResource: could not add the drill's ${plate ? 'furnace' : 'chest'} output: ${output.error}` }
      }
      // Fuel the burner-drill always; fuel the furnace too (burner furnaces need coal to smelt).
      // Use fuelAt (the SPECIFIC drill at its placed position): move_items is player-centred radius
      // 32 with no distance priority, so `fuel('burner-mining-drill')` would SPLIT the coal with any
      // other drill within 32 (e.g. the iron drill while placing the coal drill) — the new drill got
      // 0 and the rung stalled. fuelAt walks the player away from the other drill first.
      const fd = await ops.fuelAt('burner-mining-drill', { x: dp?.x ?? 0, y: dp?.y ?? 0 })
      if (!fd.ok) {
        return { ok: false, error: `automateResource: could not fuel the drill: ${fd.error}` }
      }
      if (plate) {
        const ff = await ops.fuel('stone-furnace', 'coal', 10)
        if (!ff.ok) {
          return { ok: false, error: `automateResource: could not fuel the furnace: ${ff.error}` }
        }
      }
      await waitForOutput()
      return { ok: true, data: { resource, output: plate ? 'furnace' : 'chest', mining: dp?.mining } }
    },
    bootstrap: async (): Promise<OpResult> => {
      // Hand-bootstrap the factory from an EMPTY inventory so the automation primitives can take
      // over. automateResource('iron-ore') CANNOT start from scratch: it calls ensure('burner-mining-drill')
      // → craftAll('iron-plate'), and iron-plate is SMELTED not crafted — so craftAll fails (the
      // "craftAll circular dependency" wall). This rung mines 10 iron-ore + 10 stone + 10 coal,
      // crafts a stone-furnace, smelts 5 iron-plate, crafts 2 iron-gear-wheel + 1 burner-mining-drill
      // + a spare furnace, so automateResource can then craft/place a drill and a furnace from stock.
      // Composes existing ops (ensure handles find/walk/mine, fuel handles insert, etc.) — no LLM.
      // 10 coal smelts ~11 iron-plate (measured ratio ≈ 1.14 plate/coal in Factorio 2.0 — 1 coal =
      // 4 MJ, iron-plate recipe = 3.5 MJ). The drill recipe is 3 plate + 3 gear (gear = 2 plate) =
      // 9 plate; smelt 11 for margin. 7 coal only smelts 8 (the "Have 8, need 9" wall). The drill
      // placed by automateResource later fuels itself from its own coal automation.
      if (((await ops.getState()).inventory['coal'] ?? 0) < 10) {
        const coal = await ops.ensure('coal', 10)
        if (!coal.ok) {
          return { ok: false, error: `bootstrap: could not obtain 10 coal: ${coal.error}` }
        }
      }
      // 15 ore → 12 plates smelted (the drill recipe is 3 plate + 3 gear (gear=2 plate) = 9 plate;
      // smelt 12 for margin). 15 stone → 2 furnaces (5 stone each) + margin.
      const ore = await ops.ensure('iron-ore', 15)
      if (!ore.ok) {
        return { ok: false, error: `bootstrap: could not obtain 15 iron-ore: ${ore.error}` }
      }
      const stone = await ops.ensure('stone', 15)
      if (!stone.ok) {
        return { ok: false, error: `bootstrap: could not obtain 15 stone: ${stone.error}` }
      }
      // Smelt 12 iron-plate: craft a furnace, PLACE it (ensure only crafted it into the inventory;
      // fuel/moveItems target a furnace ON THE MAP, so it must be placed first), fuel it, load ore,
      // poll, collect to inventory.
      const furnace = await ops.ensure('stone-furnace', 1)
      if (!furnace.ok) {
        return { ok: false, error: `bootstrap: could not craft a stone-furnace: ${furnace.error}` }
      }
      const me = (await ops.getState()).position
      const spots = await ops.placementSpots('stone-furnace', me, 8, 'south')
      if (!spots.spots.length) {
        return { ok: false, error: 'bootstrap: no buildable tile for a stone-furnace near the player (clear space or move)' }
      }
      const spot = spots.spots[0]
      const placed = await ops.placeAt('stone-furnace', { x: spot.x, y: spot.y, direction: 'south' })
      if (!placed.ok) {
        return { ok: false, error: `bootstrap: could not place the stone-furnace at (${spot.x},${spot.y}): ${placed.error}` }
      }
      ops.log(`bootstrap: furnace placed at ${spot.x},${spot.y}`)
      const fuel = await ops.fuel('stone-furnace', 'coal', 10)
      if (!fuel.ok) {
        return { ok: false, error: `bootstrap: could not fuel the furnace: ${fuel.error}` }
      }
      let fst = await ops.getEntity({ x: spot.x, y: spot.y })
      ops.log(`bootstrap: after fuel — fuel=${JSON.stringify(fst?.fuel)} input=${JSON.stringify(fst?.input)} output=${JSON.stringify(fst?.output)}`)
      const loaded = await ops.moveItems({ item: 'iron-ore', entity: 'stone-furnace', maxCount: 12, toEntity: true })
      if (!loaded.ok) {
        return { ok: false, error: `bootstrap: could not load iron-ore into the furnace: ${loaded.error}` }
      }
      fst = await ops.getEntity({ x: spot.x, y: spot.y })
      ops.log(`bootstrap: after load ore — fuel=${JSON.stringify(fst?.fuel)} input=${JSON.stringify(fst?.input)} output=${JSON.stringify(fst?.output)}`)
      for (let i = 0; i < 40; i++) {
        await ops.wait(60)
        const s = await ops.getState()
        // Smelted plates sit in the FURNACE OUTPUT until collectOutput — the inventory stays 0
        // meanwhile, so checking only inventory made this poll run the full 40s every time (and
        // pushed the bootstrap into the 120s sandbox timeout). Read the furnace output and break
        // as soon as 12 plates are smelted (in test mode the furnace smelts ~2 plate/s, so ~6s).
        fst = await ops.getEntity({ x: spot.x, y: spot.y })
        const furnacePlates = fst?.output?.find(o => o.name === 'iron-plate')?.count ?? 0
        const invPlates = s.inventory['iron-plate'] ?? 0
        if (i % 5 === 0) {
          ops.log(`bootstrap: poll ${i} tick=${s.tick} inv plates=${invPlates} furnace plates=${furnacePlates} fuel=${JSON.stringify(fst?.fuel)} input=${JSON.stringify(fst?.input)} output=${JSON.stringify(fst?.output)}`)
        }
        if (invPlates + furnacePlates >= 12) {
          break
        }
      }
      fst = await ops.getEntity({ x: spot.x, y: spot.y })
      ops.log(`bootstrap: after 40s poll — fuel=${JSON.stringify(fst?.fuel)} input=${JSON.stringify(fst?.input)} output=${JSON.stringify(fst?.output)}`)
      const collected = await ops.collectOutput('stone-furnace', 'iron-plate')
      ops.log(`bootstrap: collectOutput ok=${collected.ok} err=${collected.error ?? ''}`)
      if (!collected.ok) {
        return { ok: false, error: `bootstrap: could not collect iron-plate from the furnace: ${collected.error}` }
      }
      const plates = (await ops.getState()).inventory['iron-plate'] ?? 0
      ops.log(`bootstrap: plates in inventory=${plates}`)
      if (plates < 9) {
        return { ok: false, error: `bootstrap: smelted only ${plates} iron-plate (need 9 for drill+gears) — furnace may be no_fuel or unfed` }
      }
      // Craft the drill's ingredients explicitly, then craft the drill via craftItem (NOT
      // craftAll/ensure). craftAll('burner-mining-drill') does leaves-first and craftPlan counts
      // iron-plate = 9 (3 drill + 6 for 3 gears) WITHOUT deducting the gears already held — so it
      // fails on the smelting step "need 9, have 8" even though we hold 8 plates + 2 gears (the
      // "craftAll circular dependency" wall). craftItem just consumes the present ingredients.
      // 3 gears (6 plate) + 1 furnace (consumed by the drill) + 1 spare furnace (for
      // automateResource's drill-output) — all in inventory before the craftItem.
      const gears = await ops.ensure('iron-gear-wheel', 3)
      if (!gears.ok) {
        return { ok: false, error: `bootstrap: could not craft 3 iron-gear-wheel: ${gears.error}` }
      }
      const furnaces = await ops.ensure('stone-furnace', 2)
      if (!furnaces.ok) {
        return { ok: false, error: `bootstrap: could not craft 2 stone-furnace (1 for the drill + 1 spare): ${furnaces.error}` }
      }
      const drill = await ops.craftItem('burner-mining-drill', 1)
      if (!drill.ok) {
        return { ok: false, error: `bootstrap: could not craft a burner-mining-drill (craftItem): ${drill.error}` }
      }
      return { ok: true, data: { ironPlate: plates } }
    },
    launchRocket: async (): Promise<OpResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string }>(await deps.raw(`/c remote.call('autorio_tools','launch_rocket')`))
      return (d && d.ok === true) ? { ok: true } : { ok: false, error: (d && d.error) ? d.error : 'launch_rocket failed' }
    },
    buildSteamPower: async (): Promise<SteamPowerResult> => {
      bumpOpCount()
      const d = extractLastJsonLine<SteamPowerResult>(await deps.raw(`/c remote.call('autorio_tools','build_steam_power')`))
      return (d && typeof d === 'object' && typeof d.ok === 'boolean') ? d : { ok: false, error: 'build_steam_power failed (no/invalid response)' }
    },
    buildChain: async (recipe: string, inputs: string[], assemblerName = 'assembling-machine-1', outputChest = true): Promise<OpResult> => {
      // One-call factory chain: finds sources producing each input, places an assembler, sets the
      // recipe, routes belts + inserters from each source, wires power, adds an output chest, and
      // verifies. The LLM gives ONLY recipe + inputs — never a coordinate, belt, or inserter.
      bumpOpCount()
      const d = extractLastJsonLine<{ ok?: boolean, error?: string, assembler?: { x: number, y: number, status: string }, note?: string }>(await deps.raw(`/c remote.call('autorio_tools','build_chain',${luaArg(recipe)},${luaArg(inputs)},${luaArg(assemblerName)},${luaArg(outputChest)})`))
      return (d && d.ok === true) ? { ok: true, data: { assembler: d.assembler, note: d.note } } : { ok: false, error: (d && d.error) ? d.error : 'build_chain failed (no/invalid response)' }
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

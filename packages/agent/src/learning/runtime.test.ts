/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) as keys */
import type { GameState, Ops } from './types'
import { describe, expect, it, vi } from 'vitest'
import { createGameDataCache, createOps, extractEntryName, luaArg, runSkill } from './runtime'
import { createSettleBus } from './settle-bus'

describe('luaArg', () => {
  it('serialises numbers, booleans and escaped strings', () => {
    expect(luaArg(50)).toBe('50')
    expect(luaArg(true)).toBe('true')
    expect(luaArg('iron-ore')).toBe(`'iron-ore'`)
    expect(luaArg('o\'brien')).toBe('\'o\\\'brien\'')
  })

  it('escapes newlines so the Lua short-string stays valid', () => {
    expect(luaArg('a\nb')).toBe('\'a\\nb\'')
  })
})

describe('extractEntryName', () => {
  it('finds the LAST async function declaration', () => {
    const src = 'async function helper(){} async function main(state, ops){ await helper() }'
    expect(extractEntryName(src)).toBe('main')
  })

  it('finds an async arrow assigned to a const', () => {
    expect(extractEntryName('const run = async (state, ops) => {}')).toBe('run')
  })

  it('returns null when there is no async function', () => {
    expect(extractEntryName('const x = 5')).toBeNull()
  })

  it('picks the last TOP-LEVEL function, not a nested async helper', () => {
    const src = 'async function main(state, ops) { const helper = async () => { await ops.wait(1) }; await helper() }'
    expect(extractEntryName(src)).toBe('main')
  })
})

describe('createOps', () => {
  it('awaits settle for a task-enqueuing op and resolves ok on completion', async () => {
    const bus = createSettleBus(1000)
    const raw = vi.fn(async () => '[true,"Task started"]')
    const ops = createOps({ raw, settleBus: bus })
    const p = ops.walkToEntity('iron-ore', 50)
    bus.settle('completed')
    await expect(p).resolves.toEqual({ ok: true })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`remote.call('autorio_operations','walk_to_entity','iron-ore',50)`))
  })

  it('names the op in the error when a settling op times out', async () => {
    const bus = createSettleBus(15)
    const ops = createOps({ raw: async () => '[true]', settleBus: bus })
    await expect(ops.walkToEntity('iron-ore', 50)).resolves.toEqual({ ok: false, error: expect.stringContaining('walk_to_entity') })
  })

  it('propagates an in-game error from settle', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => '[true]', settleBus: bus })
    const p = ops.mineEntity('iron-ore', 5)
    bus.settle('error', 'No iron-ore found in 50m radius')
    await expect(p).resolves.toEqual({ ok: false, error: 'No iron-ore found in 50m radius' })
  })

  it('fails fast when craft rejects synchronously (no settle awaited)', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => '[false,"Recipe not available"]', settleBus: bus })
    await expect(ops.craftItem('stone-furnace', 1)).resolves.toEqual({ ok: false, error: 'Recipe not available' })
  })

  it('resolves research from its return value (never settles)', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => '[true,"Research started"]', settleBus: bus })
    await expect(ops.researchTechnology('automation')).resolves.toEqual({ ok: true, data: [true, 'Research started'] })
  })

  it('fails fast on a non-array (Lua error) reply', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => 'some lua error', settleBus: bus })
    await expect(ops.placeAt('stone-furnace', { x: 5, y: 5 })).resolves.toEqual({ ok: false, error: 'some lua error' })
  })

  it('throws when a skill exceeds the operation cap', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => '[true,"Research started"]', settleBus: bus, maxOps: 2 })
    await ops.researchTechnology('a')
    await ops.researchTechnology('b')
    await expect(ops.researchTechnology('c')).rejects.toThrow(/limit/)
  })

  it('parses the op return past the RCON command echo (Lua braces in the echo do not corrupt it)', async () => {
    const bus = createSettleBus(1000)
    const out = `2026 [COMMAND] <server> (command): local r={remote.call('autorio_operations','walk_to_entity','iron-ore',100)} rcon.print(tj(r))\n[true]`
    const ops = createOps({ raw: async () => out, settleBus: bus })
    const p = ops.walkToEntity('iron-ore', 100)
    bus.settle('completed')
    await expect(p).resolves.toEqual({ ok: true })
  })

  it('placeAt is a settling op with exact coords + direction in the dispatch', async () => {
    const bus = createSettleBus(1000)
    const raw = vi.fn(async () => '[true]')
    const ops = createOps({ raw, settleBus: bus })
    const p = ops.placeAt('transport-belt', { x: 5, y: 12, direction: 'south' })
    bus.settle('completed')
    await expect(p).resolves.toEqual({ ok: true })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`remote.call('autorio_operations','place_entity_at','transport-belt',5,12,'south')`))
  })

  it('placeAt returns the mod result payload (tile + status) on completion', async () => {
    const bus = createSettleBus(1000)
    const raw = vi.fn(async () => '[true]')
    const ops = createOps({ raw, settleBus: bus })
    const p = ops.placeAt('stone-furnace', { x: 53, y: -15, direction: 'north' })
    bus.result({ op: 'place', name: 'stone-furnace', x: 53, y: -15, status: 'no_fuel' })
    bus.settle('completed')
    await expect(p).resolves.toEqual({ ok: true, data: { op: 'place', name: 'stone-furnace', x: 53, y: -15, status: 'no_fuel' } })
  })

  it('placeAt propagates an in-game error (blocked tile) and defaults direction to north', async () => {
    const bus = createSettleBus(1000)
    const raw = vi.fn(async () => '[true]')
    const ops = createOps({ raw, settleBus: bus })
    const p = ops.placeAt('inserter', { x: 1, y: 2 })
    bus.settle('error', 'Cannot place inserter at (1,2): blocked')
    await expect(p).resolves.toEqual({ ok: false, error: 'Cannot place inserter at (1,2): blocked' })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'place_entity_at','inserter',1,2,'north'`))
  })

  it('scan is NOT settling — parses the JSON local map without arming the bus', async () => {
    const bus = createSettleBus(1000)
    const out = `2026 [COMMAND] <server> (command): remote.call('autorio_tools','scan_area',32)\n{"origin":{"x":0,"y":0},"radius":32,"entities":[{"name":"stone-furnace","type":"furnace","x":-5,"y":3,"direction":"north","status":"no_fuel"}],"resources":{"iron-ore":{"count":842,"x":-6,"y":18}}}`
    const ops = createOps({ raw: async () => out, settleBus: bus })
    const res = await ops.scan(32)
    expect(res.entities).toHaveLength(1)
    expect(res.entities[0]?.status).toBe('no_fuel')
    expect(res.resources['iron-ore']?.count).toBe(842)
  })

  it('placementSpots parses the spots list and passes name/center/direction in the call', async () => {
    const raw = vi.fn(async () => '{"spots":[{"x":53,"y":-15},{"x":54,"y":-15}]}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    const r = await ops.placementSpots('stone-furnace', { x: 53, y: -14 }, 6, 'north')
    expect(r.spots).toEqual([{ x: 53, y: -15 }, { x: 54, y: -15 }])
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'placement_spots','stone-furnace',53,-14,6,'north'`))
  })

  it('placementSpots defaults the center to nil (player position) and is empty on junk', async () => {
    const raw = vi.fn(async () => 'not json')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    const r = await ops.placementSpots('stone-furnace')
    expect(r.spots).toEqual([])
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'placement_spots','stone-furnace',nil,nil,8,'north'`))
  })

  it('placeDrillOn dispatches place_drill_on and surfaces the mined resource', async () => {
    const raw = vi.fn(async () => '{"ok":true,"drill":"burner-mining-drill","x":53,"y":-15,"mining":"iron-ore"}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.placeDrillOn('iron-ore')).resolves.toEqual({ ok: true, data: { mining: 'iron-ore' } })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'place_drill_on','iron-ore','burner-mining-drill'`))
  })

  it('placeDrillOn propagates the mod error when it cannot seat the drill', async () => {
    const raw = vi.fn(async () => '{"ok":false,"error":"no iron-ore under it"}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.placeDrillOn('iron-ore')).resolves.toEqual({ ok: false, error: 'no iron-ore under it' })
  })

  it('placeFurnaceAtDrill dispatches place_furnace_at_drill and returns reclaimed count', async () => {
    const raw = vi.fn(async () => '{"ok":true,"furnace":"stone-furnace","x":53,"y":-13,"reclaimed":1}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.placeFurnaceAtDrill()).resolves.toEqual({ ok: true, data: { reclaimed: 1 } })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'place_furnace_at_drill','stone-furnace'`))
  })

  it('placeBeltLine returns placed/reused/blocked and formats the blocked tiles on failure', async () => {
    const ok = createOps({ raw: async () => '{"ok":true,"placed":8,"reused":0,"blocked":[]}', settleBus: createSettleBus(1000) })
    await expect(ok.placeBeltLine(10, 4, 10, 12)).resolves.toEqual({ ok: true, data: { placed: 8, reused: 0, blocked: [] } })
    const bad = createOps({ raw: async () => '{"ok":false,"placed":3,"reused":0,"blocked":[{"x":10,"y":7}]}', settleBus: createSettleBus(1000) })
    const r = await bad.placeBeltLine(10, 4, 10, 12)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(10,7)')
  })

  it('placeInserterBetween dispatches place_inserter_between with from/to/inserter', async () => {
    const raw = vi.fn(async () => '{"ok":true,"inserter":"burner-inserter","x":5,"y":12,"direction":4}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.placeInserterBetween('stone-furnace', 'transport-belt')).resolves.toEqual({ ok: true })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'place_inserter_between','stone-furnace','transport-belt','burner-inserter'`))
  })

  it('connect dispatches connect_entities with endpoints + kind (default belt, nil name)', async () => {
    const raw = vi.fn(async () => '{"ok":true,"kind":"power","entity":"small-electric-pole","placed":3,"reused":0,"blocked":[]}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.connect(10, 4, 22, 4, 'power')).resolves.toEqual({ ok: true, data: { placed: 3, reused: 0, blocked: [] } })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'connect_entities',10,4,22,4,'power',nil`))
  })

  it('connect formats the blocked tiles on a partial belt connection', async () => {
    const ops = createOps({ raw: async () => '{"ok":false,"kind":"belt","placed":2,"reused":0,"blocked":[{"x":12,"y":4}]}', settleBus: createSettleBus(1000) })
    const r = await ops.connect(10, 4, 14, 4, 'belt')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('(12,4)')
  })

  it('placeNextTo dispatches place_next_to and returns the placed tile + status', async () => {
    const raw = vi.fn(async () => '{"ok":true,"entity":"lab","x":6,"y":7,"status":"no_power"}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.placeNextTo('lab', 'small-electric-pole')).resolves.toEqual({ ok: true, data: { x: 6, y: 7, status: 'no_power' } })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'place_next_to','lab','small-electric-pole',nil`))
  })

  it('reports a clear error when ops.skill is called before the library is wired', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => '[true]', settleBus: bus })
    await expect(ops.skill('build_smelting')).resolves.toEqual({ ok: false, error: expect.stringContaining('not available yet') })
  })

  it('memoises describeEntity — one RCON call for repeated lookups', async () => {
    const cache = createGameDataCache()
    const raw = vi.fn(async () => JSON.stringify({ entity: { name: 'stone-furnace', type: 'furnace', energySource: 'burner', needsFuel: true, size: { w: 2, h: 2 } } }))
    const ops = createOps({ raw, settleBus: createSettleBus(1000), cache })
    const a = await ops.describeEntity('stone-furnace')
    const b = await ops.describeEntity('stone-furnace')
    expect(a).toEqual(b)
    expect(raw).toHaveBeenCalledTimes(1)
  })

  it('invalidates research-dependent lookups (getRecipe) when researchedCount rises', async () => {
    const cache = createGameDataCache()
    let researched = 0
    const raw = vi.fn(async (input: string) => {
      if (input.includes('getstate')) {
        return JSON.stringify({ tick: 1, inventory: {}, entities: {}, researched_count: researched })
      }
      return JSON.stringify({ recipe: { name: 'electronic-circuit', ingredients: [], products: [], enabled: true, category: 'crafting' } })
    })
    const ops = createOps({ raw, settleBus: createSettleBus(1000), cache })
    const describeCalls = () => raw.mock.calls.filter(c => String(c[0]).includes('\'describe\'')).length

    await ops.getState() // epoch -> 0
    await ops.getRecipe('electronic-circuit') // fetch
    await ops.getRecipe('electronic-circuit') // cached, no fetch
    expect(describeCalls()).toBe(1)

    researched = 1
    await ops.getState() // researchedCount rose -> recipe cache cleared
    await ops.getRecipe('electronic-circuit') // fetch again
    expect(describeCalls()).toBe(2)
  })
})

function makeMockOps(): Ops {
  const logs: string[] = []
  const ok = async () => ({ ok: true })
  return {
    logs,
    log: (m: string) => { logs.push(m) },
    getState: async () => ({ tick: 0, inventory: {}, entities: {} }),
    walkToEntity: ok,
    walkTo: ok,
    mineEntity: ok,
    moveItems: ok,
    craftItem: ok,
    setRecipe: ok,
    buildSteamPower: async () => ({ ok: true }),
    researchTechnology: ok,
    wait: ok,
    attackNearestEnemy: ok,
    skill: ok,
    placeAt: ok,
    scan: async () => ({ entities: [], resources: {} }),
    renderMap: async () => null,
    getRecipe: async () => null,
    describeEntity: async () => null,
    findNearest: async () => null,
    placementSpots: async () => ({ spots: [] }),
    placeDrillOn: async () => ({ ok: true }),
    placeFurnaceAtDrill: async () => ({ ok: true }),
    placeBeltLine: async () => ({ ok: true }),
    placeInserterBetween: async () => ({ ok: true }),
    connect: async () => ({ ok: true }),
    placeNextTo: async () => ({ ok: true }),
    craftPlan: async () => null,
    techFor: async () => null,
    usedIn: async () => [],
    productionStats: async () => null,
  } as Ops
}

describe('runSkill (sandbox)', () => {
  const state: GameState = { tick: 0, inventory: {}, entities: {} }

  it('runs a happy-path skill and collects logs', async () => {
    const ops = makeMockOps()
    const src = 'async function build(state, ops) { await ops.placeAt("x", { x: 1, y: 1 }); ops.log("done") }'
    const res = await runSkill(src, ops, state)
    expect(res.ok).toBe(true)
    expect(res.logs).toContain('done')
  })

  it('captures a thrown runtime error', async () => {
    const res = await runSkill('async function f(state, ops) { throw new Error("boom") }', makeMockOps(), state)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('boom')
  })

  it('rejects code with no async function', async () => {
    const res = await runSkill('const x = 5', makeMockOps(), state)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('no async function')
  })

  it('denies access to Node globals (no process / require)', async () => {
    const res = await runSkill('async function f(state, ops) { return process.pid }', makeMockOps(), state)
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/process is not defined/)
  })

  it('exposes ops and state to the skill', async () => {
    const ops = makeMockOps()
    const s: GameState = { tick: 1, inventory: { 'iron-ore': 5 }, entities: {} }
    const src = 'async function f(state, ops) { ops.log("iron=" + (state.inventory["iron-ore"] || 0)) }'
    const res = await runSkill(src, ops, s)
    expect(res.ok).toBe(true)
    expect(ops.logs).toContain('iron=5')
  })
})

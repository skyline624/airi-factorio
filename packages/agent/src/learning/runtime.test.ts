/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) as keys */
import type { GameState, Ops } from './types'
import { describe, expect, it, vi } from 'vitest'
import { createOps, extractEntryName, luaArg, runSkill } from './runtime'
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
    await expect(ops.placeEntity('stone-furnace')).resolves.toEqual({ ok: false, error: 'some lua error' })
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

  it('reports a clear error when ops.skill is called before the library is wired', async () => {
    const bus = createSettleBus(1000)
    const ops = createOps({ raw: async () => '[true]', settleBus: bus })
    await expect(ops.skill('build_smelting')).resolves.toEqual({ ok: false, error: expect.stringContaining('not available yet') })
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
    mineEntity: ok,
    placeEntity: ok,
    moveItems: ok,
    craftItem: ok,
    researchTechnology: ok,
    wait: ok,
    attackNearestEnemy: ok,
    skill: ok,
    placeAt: ok,
    placeInserterBetween: ok,
    placeBeltLine: ok,
    placeDrillOn: ok,
    scan: async () => ({ entities: [], resources: {} }),
    getRecipe: async () => null,
    describeEntity: async () => null,
    findNearest: async () => null,
    craftPlan: async () => null,
    techFor: async () => null,
    usedIn: async () => [],
  } as Ops
}

describe('runSkill (sandbox)', () => {
  const state: GameState = { tick: 0, inventory: {}, entities: {} }

  it('runs a happy-path skill and collects logs', async () => {
    const ops = makeMockOps()
    const src = 'async function build(state, ops) { await ops.placeEntity("x"); ops.log("done") }'
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

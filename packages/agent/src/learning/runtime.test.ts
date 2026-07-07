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

  it('getEntity parses rich machine detail (recipe/missingIngredients) and dispatches floored coords', async () => {
    const raw = vi.fn(async () => '{"name":"assembling-machine-1","type":"assembling-machine","x":10,"y":4,"direction":"north","status":"item_ingredient_shortage","recipe":"iron-gear-wheel","input":[{"name":"iron-plate","count":1}],"missingIngredients":["iron-plate (have 1/2)"]}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    const d = await ops.getEntity({ x: 10.7, y: 4.9 })
    expect(d?.recipe).toBe('iron-gear-wheel')
    expect(d?.missingIngredients).toEqual(['iron-plate (have 1/2)'])
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'get_entity',10,4`))
  })

  it('getEntity returns null when there is no machine at the tile', async () => {
    const ops = createOps({ raw: async () => '{}', settleBus: createSettleBus(1000) })
    await expect(ops.getEntity({ x: 0, y: 0 })).resolves.toBeNull()
  })

  it('launchRocket dispatches launch_rocket and resolves ok on a successful launch', async () => {
    const raw = vi.fn(async () => '{"ok":true,"x":40,"y":-12}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.launchRocket()).resolves.toEqual({ ok: true })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`remote.call('autorio_tools','launch_rocket')`))
  })

  it('launchRocket surfaces the no-finished-rocket error', async () => {
    const ops = createOps({ raw: async () => '{"ok":false,"error":"silo at (40,-12) has no finished rocket yet — feed it rocket parts and wait for assembly","rocketParts":12}', settleBus: createSettleBus(1000) })
    await expect(ops.launchRocket()).resolves.toEqual({ ok: false, error: expect.stringContaining('no finished rocket') })
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

  it('placeChestAtDrill dispatches place_chest_at_drill and returns the placed chest tile', async () => {
    const raw = vi.fn(async () => '{"ok":true,"chest":"wooden-chest","x":16,"y":73,"reclaimed":0}')
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.placeChestAtDrill()).resolves.toEqual({ ok: true, data: { chest: 'wooden-chest', x: 16, y: 73, reclaimed: 0 } })
    expect(raw).toHaveBeenCalledWith(expect.stringContaining(`'place_chest_at_drill','wooden-chest'`))
  })

  it('placeChestAtDrill propagates the mod error when the output is blocked', async () => {
    const ops = createOps({ raw: async () => '{"ok":false,"error":"could not seat a chest on the drill output tile (still blocked after clearing)"}', settleBus: createSettleBus(1000) })
    await expect(ops.placeChestAtDrill()).resolves.toMatchObject({ ok: false, error: expect.stringContaining('blocked') })
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

describe('composite primitives (craftAll / ensure / fuel / collectOutput)', () => {
  // A raw router: mutable inventory for getstate, plus canned tool/op replies keyed by command.
  function router(inv: Record<string, number>, extra?: (input: string) => string | null) {
    return vi.fn(async (input: string) => {
      if (input.includes('getstate')) {
        return JSON.stringify({ tick: 1, inventory: inv, entities: {}, researched_count: 0 })
      }
      const e = extra?.(input)
      if (e !== null && e !== undefined) {
        return e
      }
      // Settling ops reply [true]; their settle is driven in the test.
      return '[true]'
    })
  }

  it('craftAll short-circuits when you already hold enough', async () => {
    const raw = router({ 'iron-gear-wheel': 5 })
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.craftAll('iron-gear-wheel', 4)).resolves.toMatchObject({ ok: true, data: { alreadyHad: 5 } })
    // No craft_plan lookup needed.
    expect(raw.mock.calls.some(c => String(c[0]).includes('craft_plan'))).toBe(false)
  })

  it('craftAll fails clearly when the chain needs research', async () => {
    const raw = router({}, (input) => {
      if (input.includes('craft_plan')) {
        return JSON.stringify({ item: 'offshore-pump', count: 1, raw: {}, steps: [], locked: ['electronics'] })
      }
      return null
    })
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    const r = await ops.craftAll('offshore-pump')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('research')
  })

  it('craftAll crafts the whole chain leaves-first then the item', async () => {
    const bus = createSettleBus(1000)
    // inventory stays empty in getstate; craftItem is a settling op we resolve immediately.
    const raw = router({}, (input) => {
      if (input.includes('craft_plan')) {
        return JSON.stringify({
          item: 'offshore-pump',
          count: 1,
          raw: {},
          steps: [
            { name: 'pipe', amount: 3, category: 'crafting', enabled: true },
            { name: 'iron-gear-wheel', amount: 2, category: 'crafting', enabled: true },
          ],
          locked: [],
        })
      }
      return null
    })
    const ops = createOps({ raw, settleBus: bus })
    // craftItem settles via 'All operations completed'; auto-complete each craft op.
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    // The final held-count check will still read 0 -> expect a clear shortfall error, but the
    // key assertion is that it dispatched craft_item for BOTH intermediates.
    await ops.craftAll('offshore-pump')
    const craftCalls = raw.mock.calls.map(c => String(c[0])).filter(s => s.includes('craft_item'))
    expect(craftCalls.some(s => s.includes(`'pipe',3`))).toBe(true)
    expect(craftCalls.some(s => s.includes(`'iron-gear-wheel',2`))).toBe(true)
  })

  it('ensure crafts a craftable item (delegates to craftAll)', async () => {
    const raw = router({}, (input) => {
      if (input.includes('\'describe\'')) {
        return JSON.stringify({ recipe: { name: 'pipe', ingredients: [], products: [], enabled: true, category: 'crafting' } })
      }
      if (input.includes('craft_plan')) {
        return JSON.stringify({ item: 'pipe', count: 2, raw: {}, steps: [], locked: [] })
      }
      return null
    })
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    await ops.ensure('pipe', 2)
    expect(raw.mock.calls.some(c => String(c[0]).includes('craft_plan'))).toBe(true)
  })

  it('ensure mines a raw (non-craftable) resource', async () => {
    const raw = router({}, (input) => {
      if (input.includes('\'describe\'')) {
        return JSON.stringify({}) // no recipe -> raw resource
      }
      return null
    })
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    await ops.ensure('coal', 10)
    const cmds = raw.mock.calls.map(c => String(c[0]))
    expect(cmds.some(s => s.includes('walk_to_entity') && s.includes('coal'))).toBe(true)
    expect(cmds.some(s => s.includes('mine_entity') && s.includes('coal'))).toBe(true)
  })

  it('fuel obtains fuel, walks, and loads it in one call', async () => {
    // Already hold coal -> skips ensure; just walk + move.
    const raw = router({ coal: 20 })
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    await expect(ops.fuel('stone-furnace')).resolves.toEqual({ ok: true })
    const cmds = raw.mock.calls.map(c => String(c[0]))
    expect(cmds.some(s => s.includes('walk_to_entity') && s.includes('stone-furnace'))).toBe(true)
    expect(cmds.some(s => s.includes('move_items') && s.includes('coal') && s.includes('stone-furnace'))).toBe(true)
  })

  it('collectOutput walks and extracts the named item from the machine output', async () => {
    const raw = router({}, () => null)
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    await expect(ops.collectOutput('stone-furnace', 'iron-plate')).resolves.toMatchObject({ ok: true })
    const cmds = raw.mock.calls.map(c => String(c[0]))
    // move_items with toEntity:false (the 4th arg is false) to TAKE from the furnace.
    expect(cmds.some(s => s.includes('move_items') && s.includes('iron-plate') && s.includes('false'))).toBe(true)
  })

  it('connectPowerTo locates the engine + target, ensures a pole (already held), and dispatches connect power', async () => {
    const raw = router({ 'small-electric-pole': 5 }, (input) => {
      if (input.includes('scan_area')) {
        return '{"origin":{"x":0,"y":0},"radius":60,"entities":[{"name":"steam-engine","type":"generator","x":39,"y":25,"direction":"north","status":"not_plugged_in"},{"name":"lab","type":"lab","x":10,"y":10,"direction":"north","status":"no_power"}],"resources":{}}'
      }
      if (input.includes('connect_entities')) {
        return '{"ok":true,"kind":"power","entity":"small-electric-pole","placed":4,"reused":0,"blocked":[]}'
      }
      return null
    })
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.connectPowerTo('lab')).resolves.toMatchObject({ ok: true })
    const cmds = raw.mock.calls.map(c => String(c[0]))
    // Wires from the engine (39,25) to the lab (10,10) with kind='power'.
    expect(cmds.some(s => s.includes(`'connect_entities',39,25,10,10,'power'`))).toBe(true)
  })

  it('connectPowerTo fails clearly when there is no steam-engine nearby', async () => {
    const raw = router({}, (input) => {
      if (input.includes('scan_area')) {
        return '{"origin":{"x":0,"y":0},"radius":60,"entities":[{"name":"lab","type":"lab","x":10,"y":10,"direction":"north","status":"no_power"}],"resources":{}}'
      }
      return null
    })
    const ops = createOps({ raw, settleBus: createSettleBus(1000) })
    await expect(ops.connectPowerTo('lab')).resolves.toMatchObject({ ok: false, error: expect.stringContaining('no steam-engine') })
  })

  it('automateResource on a SMELTABLE ore places a drill + FURNACE and fuels both', async () => {
    // Hold the drill + furnace + coal so `ensure` short-circuits (already-held) and we exercise the placement path.
    const raw = router({ 'coal': 50, 'burner-mining-drill': 1, 'stone-furnace': 1 }, (input) => {
      if (input.includes('place_drill_on')) {
        return '{"ok":true,"drill":"burner-mining-drill","x":5,"y":5,"mining":"iron-ore"}'
      }
      if (input.includes('place_furnace_at_drill')) {
        return '{"ok":true,"furnace":"stone-furnace","x":5,"y":3,"reclaimed":0}'
      }
      return null
    })
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    await expect(ops.automateResource('iron-ore')).resolves.toMatchObject({ ok: true, data: { output: 'furnace' } })
    const cmds = raw.mock.calls.map(c => String(c[0]))
    expect(cmds.some(s => s.includes(`'place_drill_on','iron-ore'`))).toBe(true)
    expect(cmds.some(s => s.includes('place_furnace_at_drill'))).toBe(true)
    expect(cmds.some(s => s.includes('place_chest_at_drill'))).toBe(false)
  })

  it('automateResource on COAL places a drill + CHEST (no furnace) and fuels the drill', async () => {
    // Hold the drill + chest + coal so `ensure` short-circuits — the coal bootstrap must not need a craft here.
    const raw = router({ 'coal': 50, 'burner-mining-drill': 1, 'wooden-chest': 1 }, (input) => {
      if (input.includes('find_nearest')) {
        return '{"name":"coal","x":250,"y":-30,"distance":260}' // distant patch — reachable via find-then-walk
      }
      if (input.includes('place_drill_on')) {
        return '{"ok":true,"drill":"burner-mining-drill","x":9,"y":9,"mining":"coal"}'
      }
      if (input.includes('place_chest_at_drill')) {
        return '{"ok":true,"chest":"wooden-chest","x":9,"y":7,"reclaimed":0}'
      }
      return null
    })
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    await expect(ops.automateResource('coal')).resolves.toMatchObject({ ok: true, data: { output: 'chest' } })
    const cmds = raw.mock.calls.map(c => String(c[0]))
    // find-then-walk: findNearest locates the distant patch, then walkTo its coords.
    expect(cmds.some(s => s.includes(`'find_nearest','coal'`))).toBe(true)
    expect(cmds.some(s => s.includes(`'walk_to_position',250,-30`))).toBe(true)
    expect(cmds.some(s => s.includes(`'place_drill_on','coal'`))).toBe(true)
    expect(cmds.some(s => s.includes('place_chest_at_drill'))).toBe(true)
    // Coal doesn't smelt -> NO furnace.
    expect(cmds.some(s => s.includes('place_furnace_at_drill'))).toBe(false)
  })

  it('automateResource is IDEMPOTENT: an existing drill on the resource is REPAIRED, not re-placed', async () => {
    // A copper drill already mines the patch (status waiting_for_space, no output/fuel yet).
    const raw = router({ 'coal': 50, 'stone-furnace': 2 }, (input) => {
      if (input.includes('find_nearest')) {
        return '{"name":"copper-ore","x":40,"y":-10,"distance":30}'
      }
      if (input.includes('scan_area')) {
        return '{"origin":{"x":0,"y":0},"radius":32,"entities":[{"name":"burner-mining-drill","type":"mining-drill","x":41,"y":-11,"direction":"north","status":"waiting_for_space_in_destination","mining":"copper-ore"}],"resources":{}}'
      }
      if (input.includes('place_furnace_at_drill')) {
        return '{"ok":true,"furnace":"stone-furnace","x":41,"y":-13,"reclaimed":0}'
      }
      return null
    })
    const bus = createSettleBus(1000)
    const orig = bus.arm.bind(bus)
    vi.spyOn(bus, 'arm').mockImplementation(() => { const p = orig(); queueMicrotask(() => bus.settle('completed')); return p })
    const ops = createOps({ raw, settleBus: bus })
    const r = await ops.automateResource('copper-ore')
    expect(r).toMatchObject({ ok: true, data: { repaired: 1 } })
    const cmds = raw.mock.calls.map(c => String(c[0]))
    // REPAIR path: no new drill placed; the existing one gets its furnace + fuel.
    expect(cmds.some(s => s.includes('place_drill_on'))).toBe(false)
    expect(cmds.some(s => s.includes('place_furnace_at_drill'))).toBe(true)
    expect(cmds.some(s => s.includes('move_items'))).toBe(true)
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
    craftAll: ok,
    ensure: ok,
    fuel: ok,
    collectOutput: ok,
    launchRocket: ok,
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
    getEntity: async () => null,
    findNearest: async () => null,
    placementSpots: async () => ({ spots: [] }),
    placeDrillOn: async () => ({ ok: true }),
    placeFurnaceAtDrill: async () => ({ ok: true }),
    placeChestAtDrill: async () => ({ ok: true }),
    automateResource: ok,
    placeBeltLine: async () => ({ ok: true }),
    placeInserterBetween: async () => ({ ok: true }),
    connect: async () => ({ ok: true }),
    connectPowerTo: async () => ({ ok: true }),
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

/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) and snake_case JSON keys */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { diffState, parseGameState, parseScan } from './state'

describe('parseGameState', () => {
  it('parses a normal snapshot and maps snake_case fields', () => {
    const json = JSON.stringify({
      tick: 123,
      position: { x: 1.5, y: -2 },
      health: 80,
      max_health: 100,
      inventory: { 'iron-ore': 10 },
      entities: { 'burner-mining-drill': 2 },
      current_research: 'automation',
      researched_count: 3,
    })
    expect(parseGameState(json)).toEqual({
      tick: 123,
      position: { x: 1.5, y: -2 },
      health: 80,
      maxHealth: 100,
      inventory: { 'iron-ore': 10 },
      entities: { 'burner-mining-drill': 2 },
      currentResearch: 'automation',
      researchedCount: 3,
    })
  })

  it('treats an empty Lua table ([]) as an empty record', () => {
    const s = parseGameState(JSON.stringify({ tick: 1, inventory: [], entities: [] }))
    expect(s.inventory).toEqual({})
    expect(s.entities).toEqual({})
  })

  it('survives junk and omits absent fields', () => {
    expect(parseGameState('not json').inventory).toEqual({})
    expect(parseGameState(JSON.stringify({ tick: 1, inventory: {} })).health).toBeUndefined()
  })

  it('recovers state from a raw RCON reply that includes the command echo + Lua braces', () => {
    const out = `2026-06-08 23:33 [COMMAND] <server> (command): local p=game.get_player(1) find_entities_filtered{force=p.force,radius=200} rcon.print(tj({tick=game.tick}))\n{"tick":560254,"position":{"x":-28.375,"y":82.57},"inventory":{"iron-ore":24,"coal":30},"entities":{"burner-mining-drill":2}}`
    const s = parseGameState(out)
    expect(s.tick).toBe(560254)
    expect(s.inventory['iron-ore']).toBe(24)
    expect(s.entities['burner-mining-drill']).toBe(2)
    expect(s.position).toEqual({ x: -28.375, y: 82.57 })
  })
})

describe('diffState', () => {
  it('reports inventory gains/losses, builds and research progress', () => {
    const before: GameState = { tick: 0, inventory: { 'iron-ore': 5 }, entities: {}, researchedCount: 1 }
    const after: GameState = { tick: 50, inventory: { 'iron-ore': 2, 'iron-plate': 8 }, entities: { 'stone-furnace': 1 }, researchedCount: 2 }
    const d = diffState(before, after)
    expect(d).toContain('iron-plate +8')
    expect(d).toContain('iron-ore -3')
    expect(d).toContain('stone-furnace +1')
    expect(d).toContain('Technologies researched: 1 -> 2')
  })

  it('reports "(none)" when nothing changed', () => {
    const s: GameState = { tick: 0, inventory: {}, entities: {} }
    const d = diffState(s, s)
    expect(d).toContain('Inventory gained: (none)')
    expect(d).toContain('Entities built: (none)')
  })
})

describe('parseScan', () => {
  it('parses entities (with direction/status) and aggregated resources', () => {
    const json = JSON.stringify({
      origin: { x: 1, y: 2 },
      radius: 32,
      entities: [{ name: 'transport-belt', type: 'transport-belt', x: 5, y: 12, direction: 'east', status: 'working' }],
      resources: { 'iron-ore': { count: 500, x: -3, y: 8 } },
    })
    const s = parseScan(json)
    expect(s.origin).toEqual({ x: 1, y: 2 })
    expect(s.entities[0]).toEqual({ name: 'transport-belt', type: 'transport-belt', x: 5, y: 12, direction: 'east', status: 'working' })
    expect(s.resources['iron-ore']).toEqual({ count: 500, x: -3, y: 8 })
  })

  it('recovers from a raw RCON reply with the command echo + Lua braces', () => {
    const out = `2026 [COMMAND] <server> (command): remote.call('autorio_tools','scan_area',32)\n{"entities":[{"name":"stone-furnace","type":"furnace","x":0,"y":0,"direction":"north","status":"working"}],"resources":{}}`
    expect(parseScan(out).entities[0]?.name).toBe('stone-furnace')
  })

  it('handles empty / junk defensively', () => {
    expect(parseScan('{}')).toEqual({ origin: undefined, radius: undefined, entities: [], resources: {} })
    expect(parseScan('not json').entities).toEqual([])
  })
})

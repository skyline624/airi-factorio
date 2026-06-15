/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) and snake_case JSON keys */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { buildBatchedCaptureCommand, buildCaptureStateCommand, buildPlayerResolveSnippet, buildScreenshotCommand, CAPTURE_STATE_COMMAND, diffState, parseBatchedCapture, parseGameState, parseScan } from './state'

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

describe('buildPlayerResolveSnippet', () => {
  it('auto-detects (empty name): targets nothing, scans connected players, falls back to get_player(1)', () => {
    const s = buildPlayerResolveSnippet('')
    expect(s).toContain('TARGET=\'\'')
    expect(s).toContain('q.connected')
    // Legacy fallback retained so the RCON echo still mentions get_player(1).
    expect(s).toContain('game.get_player(1)')
  })

  it('targets an explicit name via a name-match loop', () => {
    const s = buildPlayerResolveSnippet('Alice')
    expect(s).toContain('TARGET=\'Alice\'')
    expect(s).toContain('q.name==TARGET')
  })

  it('escapes a single quote so a name cannot break out of the Lua literal', () => {
    const s = buildPlayerResolveSnippet('O\'Brien')
    // The quote is backslash-escaped; the literal stays one string.
    expect(s).toContain('TARGET=\'O\\\'Brien\'')
  })

  it('neutralises an injection attempt in the player name', () => {
    // A name crafted to close the literal and run extra Lua must be defanged.
    const evil = '\'); game.print(\'pwned\'); local _=(\''
    const s = buildPlayerResolveSnippet(evil)
    // No unescaped `');` sequence escapes the assignment.
    expect(s).not.toContain('TARGET=\'\');')
    expect(s).toContain('\\\'')
  })

  it('escapes backslashes, newlines and carriage returns', () => {
    expect(buildPlayerResolveSnippet('a\\b')).toContain('a\\\\b')
    expect(buildPlayerResolveSnippet('a\nb')).toContain('a\\nb')
    expect(buildPlayerResolveSnippet('a\rb')).toContain('a\\rb')
  })
})

describe('buildCaptureStateCommand', () => {
  it('is a /c command that captures inventory + entities for the resolved player', () => {
    const cmd = buildCaptureStateCommand('')
    expect(cmd.startsWith('/c ')).toBe(true)
    expect(cmd).toContain('rcon.print')
    expect(cmd).toContain('get_main_inventory')
    expect(cmd).toContain('resolve()')
  })

  it('matches the default CAPTURE_STATE_COMMAND when the name is empty', () => {
    expect(buildCaptureStateCommand('')).toBe(CAPTURE_STATE_COMMAND)
  })
})

describe('buildScreenshotCommand', () => {
  it('takes a screenshot from the resolved player POV at the given path', () => {
    const cmd = buildScreenshotCommand('shot.png', 'Bob')
    expect(cmd.startsWith('/c ')).toBe(true)
    expect(cmd).toContain('take_screenshot')
    expect(cmd).toContain('path=\'shot.png\'')
    expect(cmd).toContain('by_player=p')
    expect(cmd).toContain('TARGET=\'Bob\'')
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

describe('buildBatchedCaptureCommand', () => {
  it('is a /c command that gathers state + scan_factory + production_stats in one go', () => {
    const cmd = buildBatchedCaptureCommand('')
    expect(cmd.startsWith('/c ')).toBe(true)
    expect(cmd).toContain('getstate()')
    expect(cmd).toContain('scan_factory')
    expect(cmd).toContain('production_stats')
    // Exactly one print: the combined object.
    expect(cmd.match(/rcon\.print/g)?.length).toBe(1)
  })
})

describe('parseBatchedCapture', () => {
  it('splits the combined {state,scan,production} reply', () => {
    const json = JSON.stringify({
      state: { tick: 7, inventory: { coal: 12 }, entities: { 'stone-furnace': 1 }, researched_count: 2 },
      scan: { entities: [{ name: 'stone-furnace', type: 'furnace', x: 0, y: 0, direction: 'north', status: 'working' }], resources: {} },
      production: { produced: { 'iron-plate': 30 }, consumed: { 'iron-ore': 30 } },
    })
    const b = parseBatchedCapture(json)
    expect(b.state.inventory.coal).toBe(12)
    expect(b.state.researchedCount).toBe(2)
    expect(b.scan.entities[0]?.status).toBe('working')
    expect(b.production).toEqual({ 'iron-plate': 30 })
  })

  it('defaults missing sub-objects (nil scan/production) without throwing', () => {
    const b = parseBatchedCapture(JSON.stringify({ state: { tick: 1, inventory: {}, entities: {} } }))
    expect(b.scan.entities).toEqual([])
    expect(b.production).toBeNull()
  })

  it('survives junk', () => {
    const b = parseBatchedCapture('not json')
    expect(b.state.inventory).toEqual({})
    expect(b.scan.entities).toEqual([])
    expect(b.production).toBeNull()
  })
})

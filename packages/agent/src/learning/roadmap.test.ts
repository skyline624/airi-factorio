/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal names */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { ROADMAP, selectRung } from './roadmap'

const baseState: GameState = { tick: 0, inventory: {}, entities: {}, researchedCount: 0 }
const ctx = (resources: Record<string, { count: number, x: number, y: number }>) => ({ state: baseState, resources })

describe('selectRung', () => {
  it('returns bootstrap first (it has NO precondition, even with no resources reachable)', () => {
    const sel = selectRung(ROADMAP, new Set(), ctx({}))
    expect(sel.rung?.id).toBe('bootstrap')
    expect(sel.blocked).toBe(false)
  })

  it('is BLOCKED when the next rung (iron) needs a resource that isn\'t reachable (yield to the LLM)', () => {
    const sel = selectRung(ROADMAP, new Set(['bootstrap']), ctx({}))
    expect(sel.blocked).toBe(true)
    if (sel.blocked) {
      expect(sel.rung).toBeNull()
      expect(sel.reason).toContain('iron-ore')
    }
  })

  it('skips done rungs and returns the next one whose precondition is ready', () => {
    const sel = selectRung(ROADMAP, new Set(['bootstrap', 'iron', 'coal']), ctx({ 'copper-ore': { count: 300, x: 0, y: 0 } }))
    expect(sel.rung?.id).toBe('copper')
  })

  it('is blocked (exhausted) when every rung is done', () => {
    const all = new Set(ROADMAP.map(r => r.id))
    const sel = selectRung(ROADMAP, all, ctx({}))
    expect(sel.blocked).toBe(true)
    if (sel.blocked) {
      expect(sel.rung).toBeNull()
      expect(sel.reason).toContain('exhausted')
    }
  })

  it('a rung WITHOUT a precondition (steam/pole/gears/circuits) is ready as soon as it is next', () => {
    const sel = selectRung(ROADMAP, new Set(['bootstrap', 'iron', 'coal', 'copper']), ctx({}))
    expect(sel.rung?.id).toBe('steam')
    expect(sel.blocked).toBe(false)
  })

  it('the roadmap is ordered bootstrap → iron → coal → copper → steam → pole → gears → circuits', () => {
    expect(ROADMAP.map(r => r.id)).toEqual(['bootstrap', 'iron', 'coal', 'copper', 'steam', 'pole', 'gears', 'circuits'])
  })
})
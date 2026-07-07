/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) as keys */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { evaluateSuccessCheck, precheckVerdict } from './precheck'

const base: GameState = { tick: 0, inventory: {}, entities: {}, researchedCount: 0 }
function state(patch: Partial<GameState>): GameState {
  return { ...base, ...patch }
}

describe('precheckVerdict', () => {
  it('passes a quantified mine objective when the item was gained', () => {
    const r = precheckVerdict({
      objective: 'Mine 20 iron ore',
      before: state({ inventory: { 'iron-ore': 0 } }),
      after: state({ inventory: { 'iron-ore': 21 } }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('does NOT pass a mine objective when the gain is short of the stated count', () => {
    const r = precheckVerdict({
      objective: 'Mine 20 iron ore',
      before: state({ inventory: { 'iron-ore': 0 } }),
      after: state({ inventory: { 'iron-ore': 5, 'stone': 3 } }),
    })
    // Something changed (so not a clean no-op) but the target is unmet -> defer to the LLM.
    expect(r.decided).toBe(false)
  })

  it('fails a mine objective on a clean no-op', () => {
    const r = precheckVerdict({
      objective: 'Mine 20 iron ore',
      before: state({ inventory: { 'iron-ore': 5 } }),
      after: state({ inventory: { 'iron-ore': 5 } }),
    })
    expect(r).toMatchObject({ decided: true, success: false })
  })

  it('passes a craft objective via the production counters (output not in inventory)', () => {
    const r = precheckVerdict({
      objective: 'Smelt 10 iron plates',
      before: state({}),
      after: state({}),
      prodBefore: { 'iron-plate': 2 },
      prodAfter: { 'iron-plate': 12 },
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('passes a build objective when the entity count rose', () => {
    const r = precheckVerdict({
      objective: 'Place a burner mining drill on the iron patch',
      before: state({ entities: {} }),
      after: state({ entities: { 'burner-mining-drill': 1 } }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('fails a build objective on a clean no-op', () => {
    const r = precheckVerdict({
      objective: 'Place a stone furnace at the drill output',
      before: state({ entities: { 'burner-mining-drill': 1 } }),
      after: state({ entities: { 'burner-mining-drill': 1 } }),
    })
    expect(r).toMatchObject({ decided: true, success: false })
  })

  it('passes a research objective when a technology completed', () => {
    const r = precheckVerdict({
      objective: 'Research automation',
      before: state({ researchedCount: 3, currentResearch: 'automation' }),
      after: state({ researchedCount: 4, currentResearch: undefined }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('defers a research objective that only STARTED (count unchanged)', () => {
    const r = precheckVerdict({
      objective: 'Research automation',
      before: state({ researchedCount: 3, currentResearch: undefined }),
      after: state({ researchedCount: 3, currentResearch: 'automation' }),
    })
    expect(r.decided).toBe(false)
  })

  it('defers a status-laden "automate" objective to the LLM critic', () => {
    const r = precheckVerdict({
      objective: 'Automate iron plate production with a powered furnace',
      before: state({ entities: {} }),
      after: state({ entities: { 'stone-furnace': 1 } }),
    })
    expect(r.decided).toBe(false)
  })

  it('defers a non-mechanical "find" objective (reactive command)', () => {
    const r = precheckVerdict({
      objective: 'find the nearest copper ore',
      before: state({}),
      after: state({}),
    })
    expect(r.decided).toBe(false)
  })
})

describe('evaluateSuccessCheck', () => {
  it('acquire: passes when the item was gained in the inventory', () => {
    const r = evaluateSuccessCheck({ kind: 'acquire', item: 'iron-ore', count: 20 }, {
      objective: 'x',
      before: state({ inventory: { 'iron-ore': 1 } }),
      after: state({ inventory: { 'iron-ore': 22 } }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('acquire: passes via the production counters when the output sits in a furnace', () => {
    const r = evaluateSuccessCheck({ kind: 'acquire', item: 'iron-plate', count: 10 }, {
      objective: 'x',
      before: state({}),
      after: state({}),
      prodBefore: { 'iron-plate': 0 },
      prodAfter: { 'iron-plate': 10 },
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('acquire: FAILS deterministically when short of the count', () => {
    const r = evaluateSuccessCheck({ kind: 'acquire', item: 'iron-ore', count: 20 }, {
      objective: 'x',
      before: state({ inventory: { 'iron-ore': 0 } }),
      after: state({ inventory: { 'iron-ore': 5 } }),
    })
    expect(r).toMatchObject({ decided: true, success: false })
  })

  it('acquire: PASSES when the item is ALREADY held (no gain needed — "have N", not "gain N")', () => {
    // The agent already holds 1 drill from an earlier objective; "acquire 1 drill" must PASS
    // (it holds one) instead of failing on a +0 delta and looping the objective forever.
    const r = evaluateSuccessCheck({ kind: 'acquire', item: 'burner-mining-drill', count: 1 }, {
      objective: 'x',
      before: state({ inventory: { 'burner-mining-drill': 1 } }),
      after: state({ inventory: { 'burner-mining-drill': 1 } }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('produce: PASSES when the force production counter rose (the automation/working signal)', () => {
    const r = evaluateSuccessCheck({ kind: 'produce', item: 'iron-plate', count: 5 }, {
      objective: 'x',
      before: state({}),
      after: state({}),
      prodBefore: { 'iron-plate': 3 },
      prodAfter: { 'iron-plate': 9 },
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('produce: FAILS deterministically (no LLM) when nothing was produced — the case precheck used to defer', () => {
    const r = evaluateSuccessCheck({ kind: 'produce', item: 'iron-plate', count: 5 }, {
      objective: 'automate iron plates',
      before: state({ entities: { 'stone-furnace': 1 } }),
      after: state({ entities: { 'stone-furnace': 1 } }),
      prodBefore: { 'iron-plate': 3 },
      prodAfter: { 'iron-plate': 3 },
    })
    expect(r).toMatchObject({ decided: true, success: false })
    expect(r.critique).toContain('iron-plate')
  })

  it('build: passes when a new entity exists', () => {
    const r = evaluateSuccessCheck({ kind: 'build', entity: 'assembling-machine-1' }, {
      objective: 'x',
      before: state({ entities: {} }),
      after: state({ entities: { 'assembling-machine-1': 1 } }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('research: passes when researchedCount increased', () => {
    const r = evaluateSuccessCheck({ kind: 'research' }, {
      objective: 'x',
      before: state({ researchedCount: 3 }),
      after: state({ researchedCount: 4 }),
    })
    expect(r).toMatchObject({ decided: true, success: true })
  })

  it('defers (decided:false) on an unknown/malformed kind so the caller falls back', () => {
    const r = evaluateSuccessCheck({ kind: 'bogus' as 'acquire' }, {
      objective: 'x',
      before: state({}),
      after: state({}),
    })
    expect(r.decided).toBe(false)
  })
})

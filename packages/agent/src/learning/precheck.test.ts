/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) as keys */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { precheckVerdict } from './precheck'

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
      after: state({ inventory: { 'iron-ore': 5, stone: 3 } }),
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

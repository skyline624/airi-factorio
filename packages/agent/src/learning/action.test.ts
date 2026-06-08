/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) as keys */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { extractCodeBlock, generateCode, summarizeState } from './action'

describe('extractCodeBlock', () => {
  it('extracts a fenced js block', () => {
    const t = 'Explain: I mine.\nPlan: walk, mine.\n```js\nasync function f(state, ops) { await ops.mineEntity("coal", 5) }\n```\n'
    expect(extractCodeBlock(t)).toBe('async function f(state, ops) { await ops.mineEntity("coal", 5) }')
  })

  it('falls back to raw when an async function is present without a fence', () => {
    expect(extractCodeBlock('async function f(state, ops) {}')).toBe('async function f(state, ops) {}')
  })

  it('returns null when there is no code', () => {
    expect(extractCodeBlock('I will mine some iron.')).toBeNull()
  })
})

describe('summarizeState', () => {
  it('summarises inventory, entities and position', () => {
    const s: GameState = { tick: 0, inventory: { 'iron-ore': 10 }, entities: { 'stone-furnace': 1 }, position: { x: 3.2, y: -4.8 } }
    const out = summarizeState(s)
    expect(out).toContain('iron-ore:10')
    expect(out).toContain('stone-furnace:1')
    expect(out).toContain('(3, -5)')
  })
})

describe('generateCode', () => {
  it('returns the extracted code from the model reply', async () => {
    const complete = async () => '```js\nasync function f(state, ops) { await ops.mineEntity("coal", 5) }\n```'
    const out = await generateCode({ objective: 'mine coal', state: { tick: 0, inventory: {}, entities: {} }, model: 'm', complete })
    expect(out.code).toContain('mineEntity')
  })

  it('returns null code when the model produces no function', async () => {
    const complete = async () => 'Sorry, I cannot.'
    const out = await generateCode({ objective: 'x', state: { tick: 0, inventory: {}, entities: {} }, model: 'm', complete })
    expect(out.code).toBeNull()
  })
})

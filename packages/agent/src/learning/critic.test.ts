/* eslint-disable ts/naming-convention -- test fixtures use Factorio internal item names (kebab-case) as keys */
import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { verify } from './critic'

const before: GameState = { tick: 0, inventory: {}, entities: {} }
const after: GameState = { tick: 100, inventory: { 'iron-plate': 50 }, entities: {} }

describe('verify', () => {
  it('parses a success verdict', async () => {
    const complete = async () => JSON.stringify({ reasoning: 'inventory gained 50 iron-plate', success: true, critique: '' })
    const v = await verify({ objective: 'make 50 iron plates', before, after, model: 'm', complete })
    expect(v.success).toBe(true)
  })

  it('parses a fenced JSON verdict and keeps the critique', async () => {
    const complete = async () => '```json\n{"success": false, "critique": "need more plates"}\n```'
    const v = await verify({ objective: 'x', before, after, model: 'm', complete })
    expect(v.success).toBe(false)
    expect(v.critique).toBe('need more plates')
  })

  it('falls back to not-met on unparseable output', async () => {
    const complete = async () => 'I think it went well!'
    const v = await verify({ objective: 'x', before, after, model: 'm', complete })
    expect(v.success).toBe(false)
    expect(v.critique).toContain('could not produce')
  })

  it('falls back to not-met when the LLM returns null', async () => {
    const complete = async () => null
    const v = await verify({ objective: 'x', before, after, model: 'm', complete })
    expect(v.success).toBe(false)
  })
})

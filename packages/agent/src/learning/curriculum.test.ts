import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { proposeNextObjective } from './curriculum'

const state: GameState = { tick: 0, inventory: {}, entities: {} }
const base = { ultimateGoal: 'Launch a rocket.', state, skills: [], completed: [], failed: [], model: 'm' }

describe('proposeNextObjective', () => {
  it('parses a proposed objective + context', async () => {
    const complete = async () => JSON.stringify({ reasoning: 'need plates', objective: 'Smelt 20 iron plates', context: 'load ore + coal, then wait' })
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Smelt 20 iron plates')
    expect(p?.context).toContain('coal')
  })

  it('recovers a fenced JSON proposal', async () => {
    const complete = async () => '```json\n{"objective":"Mine 20 copper ore","context":""}\n```'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Mine 20 copper ore')
  })

  it('returns null on unparseable output', async () => {
    const complete = async () => 'no idea, sorry'
    expect(await proposeNextObjective({ ...base, complete })).toBeNull()
  })

  it('returns null when the objective field is missing', async () => {
    const complete = async () => JSON.stringify({ reasoning: 'x' })
    expect(await proposeNextObjective({ ...base, complete })).toBeNull()
  })
})

import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { proposeNextObjective } from './curriculum'

const state: GameState = { tick: 0, inventory: {}, entities: {} }
const base = { ultimateGoal: 'Launch a rocket.', state, skills: [], completed: [], failed: [], model: 'm' }

describe('proposeNextObjective (Voyager-style line format)', () => {
  it('parses the four labelled lines', async () => {
    const complete = async () => [
      'Reasoning: need plates to craft belts',
      'Task: Smelt 20 iron plates',
      'Context: load ore + coal, then wait',
      'Check: produce iron-plate 20',
    ].join('\n')
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Smelt 20 iron plates')
    expect(p?.reasoning).toContain('belts')
    expect(p?.context).toContain('coal')
    expect(p?.successCheck).toMatchObject({ kind: 'produce', item: 'iron-plate', count: 20 })
  })

  it('parses when the model babbles around the labels (the Voyager robustness)', async () => {
    const complete = async () => [
      'Sure, here is my plan for the next step.',
      '',
      'Reasoning: standing on iron, so drill next.',
      'Task: Place a burner-mining-drill on the nearest iron-ore patch and fuel it.',
      'Context: walk within reach first.',
      'Check: build burner-mining-drill 1',
      '',
      'Hope that helps!',
    ].join('\n')
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toContain('burner-mining-drill')
    expect(p?.successCheck).toMatchObject({ kind: 'build', entity: 'burner-mining-drill', count: 1 })
  })

  it('parses when labels are wrapped in code fences (model defaults to fencing)', async () => {
    const complete = async () => '```\nTask: Mine 20 copper ore\nCheck: acquire copper-ore 20\n```'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Mine 20 copper ore')
    expect(p?.successCheck).toMatchObject({ kind: 'acquire', item: 'copper-ore', count: 20 })
  })

  it('parses a research check with no target', async () => {
    const complete = async () => 'Task: Research automation\nCheck: research'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Research automation')
    expect(p?.successCheck).toMatchObject({ kind: 'research' })
  })

  it('defaults count to 1 when omitted on acquire/produce/build', async () => {
    const complete = async () => 'Task: Place a lab\nCheck: build lab'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.successCheck).toMatchObject({ kind: 'build', entity: 'lab', count: 1 })
  })

  it('falls back to NO successCheck (deterministic precheck still covers it) when Check is malformed', async () => {
    const complete = async () => 'Task: Automate iron plates\nCheck: maybe later'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Automate iron plates')
    expect(p?.successCheck).toBeUndefined()
  })

  it('falls back to NO successCheck when the Check line is omitted entirely', async () => {
    const complete = async () => 'Reasoning: x\nTask: Find the nearest copper ore\nContext: scout east'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Find the nearest copper ore')
    expect(p?.successCheck).toBeUndefined()
  })

  it('returns null when the Task line is missing (no usable objective)', async () => {
    const complete = async () => 'Reasoning: nothing to do\nContext: hmm'
    expect(await proposeNextObjective({ ...base, complete })).toBeNull()
  })

  it('returns null on totally unparseable output', async () => {
    const complete = async () => 'no idea, sorry'
    expect(await proposeNextObjective({ ...base, complete })).toBeNull()
  })

  it('survives the reasoning-channel case (content otherwise empty-ish but Task line present)', async () => {
    // glm-5.2 sometimes routes its answer to the reasoning channel and leaves content sparse.
    // As long as a Task: line exists anywhere, we recover the objective — the whole point.
    const complete = async () => '\n\nTask: Smelt 5 iron plates\n'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Smelt 5 iron plates')
  })
})
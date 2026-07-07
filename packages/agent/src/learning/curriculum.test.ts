import type { GameState } from './types'
import { describe, expect, it } from 'vitest'
import { proposeNextObjective, stripCoordinates } from './curriculum'

const state: GameState = { tick: 0, inventory: {}, entities: {} }
const base = { ultimateGoal: 'Launch a rocket.', state, skills: [], completed: [], failedDetails: [], model: 'm' }

describe('proposeNextObjective (Voyager-style line format)', () => {
  it('parses the four labelled lines', async () => {
    const complete = async () => [
      'Reasoning: need plates to craft belts',
      'Task: Smelt some iron plates',
      'Context: load ore + coal, then wait',
      'Check: produce iron-plate 3',
    ].join('\n')
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).toBe('Smelt some iron plates')
    expect(p?.reasoning).toContain('belts')
    expect(p?.context).toContain('coal')
    expect(p?.successCheck).toMatchObject({ kind: 'produce', item: 'iron-plate', count: 3 })
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

  it('renders RECENTLY FAILED with the critique, deduped to one row per objective (latest critique)', async () => {
    let seenUser = ''
    const complete = async (m: { user: string | unknown[] }): Promise<string> => { seenUser = String(m.user); return 'Task: do something else' }
    await proposeNextObjective({
      ...base,
      failedDetails: [
        { objective: 'Fuel the boiler', critique: 'boiler had no water' },
        { objective: 'Fuel the boiler', critique: 'still no water — pipes not connected' },
      ],
      complete,
    })
    // One row for the repeated objective, carrying the LATEST critique (not the same string x2).
    expect(seenUser).toContain('RECENTLY FAILED')
    expect(seenUser).toContain('still no water — pipes not connected')
    expect((seenUser.match(/"Fuel the boiler"/g) ?? []).length).toBe(1)
  })

  it('injects a FORBIDDEN ban line when forbidObjective is set (loop breaker)', async () => {
    let seenUser = ''
    const complete = async (m: { user: string | unknown[] }): Promise<string> => { seenUser = String(m.user); return 'Task: a different objective' }
    await proposeNextObjective({ ...base, forbidObjectives: ['Fuel the boiler at (27.5,-28)'], complete })
    expect(seenUser).toContain('FORBIDDEN')
    expect(seenUser).toContain('Fuel the boiler at (27.5,-28)')
  })

  it('clamps an over-cap produce count (30 -> 5) so the check is reachable', async () => {
    const complete = async () => 'Task: Smelt lots of iron\nCheck: produce iron-plate 30'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.successCheck).toMatchObject({ kind: 'produce', item: 'iron-plate', count: 5 })
  })

  it('clamps an over-cap acquire count (99 -> 20)', async () => {
    const complete = async () => 'Task: Mine copper\nCheck: acquire copper-ore 99'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.successCheck).toMatchObject({ kind: 'acquire', item: 'copper-ore', count: 20 })
  })

  it('strips a hardcoded coordinate from the objective (the decider must not leak coords)', async () => {
    const complete = async () => 'Task: Fuel the stone-furnace at (-4, -46) with coal'
    const p = await proposeNextObjective({ ...base, complete })
    expect(p?.objective).not.toMatch(/\(-?\d+/)
    expect(p?.objective).toContain('the right spot')
  })
})

describe('stripCoordinates', () => {
  it('replaces "at (x, y)" with "at the right spot"', () => {
    expect(stripCoordinates('Place a drill at (12, -7) now')).toBe('Place a drill at the right spot now')
  })
  it('removes a bare (x, y) tuple', () => {
    expect(stripCoordinates('The furnace (-4, -46) needs coal')).toBe('The furnace needs coal')
  })
  it('leaves coordinate-free text untouched', () => {
    expect(stripCoordinates('Automate coal on the nearest patch')).toBe('Automate coal on the nearest patch')
  })
})
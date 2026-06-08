/* eslint-disable ts/naming-convention -- test fixtures use natural-language strings as map keys */
import type { CompleteOptions } from './llm'
import { describe, expect, it } from 'vitest'
import { cosineSimilarity, createSkillLibrary } from './skill-library'

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
  })

  it('returns 0 for length mismatch or empty', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2])).toBe(0)
    expect(cosineSimilarity([], [])).toBe(0)
  })
})

describe('createSkillLibrary', () => {
  const vecs: Record<string, number[]> = {
    'Mines iron ore.': [1, 0, 0],
    'Mines copper ore.': [0, 1, 0],
    'get iron': [0.95, 0.05, 0],
    'get copper': [0.05, 0.95, 0],
  }
  const embed = async (t: string): Promise<number[] | null> => vecs[t] ?? [0, 0, 0]
  const complete = async (o: CompleteOptions): Promise<string | null> => (String(o.user).includes('copper') ? 'Mines copper ore.' : 'Mines iron ore.')

  function makeLib() {
    return createSkillLibrary({ embeddingModel: 'm', descriptionModel: 'd', embed, complete })
  }

  it('adds a skill with an LLM-generated description', async () => {
    const lib = makeLib()
    const s = await lib.add({ name: 'mineIron', code: 'async function mineIron(state, ops){ /* iron */ }', objective: 'mine iron' })
    expect(s?.name).toBe('mineIron')
    expect(s?.description).toBe('Mines iron ore.')
    expect(lib.size()).toBe(1)
  })

  it('retrieves the most similar skill by query embedding', async () => {
    const lib = makeLib()
    await lib.add({ name: 'mineIron', code: 'async function mineIron(state, ops){ /* iron */ }', objective: 'mine iron' })
    await lib.add({ name: 'mineCopper', code: 'async function mineCopper(state, ops){ /* copper */ }', objective: 'mine copper' })
    const top = await lib.retrieve('get iron', 1)
    expect(top).toHaveLength(1)
    expect(top[0]?.name).toBe('mineIron')
    expect(top[0]?.code).toContain('mineIron')
  })

  it('returns an empty list when the library is empty', async () => {
    expect(await makeLib().retrieve('anything')).toEqual([])
  })

  it('counts uses when a skill of the same name is re-learned', async () => {
    const lib = makeLib()
    await lib.add({ name: 'mineIron', code: 'async function mineIron(s, o){}', objective: 'mine iron' })
    await lib.add({ name: 'mineIron', code: 'async function mineIron(s, o){ /* v2 */ }', objective: 'mine iron' })
    expect(lib.get('mineIron')?.uses).toBe(1)
    expect(lib.size()).toBe(1)
  })
})

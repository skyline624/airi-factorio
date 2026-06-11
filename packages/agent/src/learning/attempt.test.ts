import type { GenerateCodeInput } from './action'
import type { GameState, Ops, Verdict } from './types'
import { describe, expect, it, vi } from 'vitest'
import { attemptObjective } from './attempt'

const state: GameState = { tick: 0, inventory: {}, entities: {} }

function mockOps(): Ops {
  const logs: string[] = []
  const ok = async () => ({ ok: true })
  return {
    logs,
    log: (m: string) => { logs.push(m) },
    getState: async () => state,
    walkToEntity: ok,
    mineEntity: ok,
    placeEntity: ok,
    moveItems: ok,
    craftItem: ok,
    researchTechnology: ok,
    wait: ok,
    attackNearestEnemy: ok,
    skill: ok,
    placeAt: ok,
    placeInserterBetween: ok,
    placeBeltLine: ok,
    placeDrillOn: ok,
    scan: async () => ({ entities: [], resources: {} }),
    getRecipe: async () => null,
    describeEntity: async () => null,
    findNearest: async () => null,
    craftPlan: async () => null,
    techFor: async () => null,
    usedIn: async () => [],
    productionStats: async () => null,
  } as Ops
}

const base = {
  makeOps: mockOps,
  captureState: async () => state,
  actionModel: 'a',
  criticModel: 'c',
  sandboxTimeoutMs: 5000,
}

const CODE = 'async function f(state, ops) { await ops.mineEntity("coal", 5) }'

describe('attemptObjective', () => {
  it('succeeds on the first attempt when the critic approves', async () => {
    const generateCode = vi.fn(async () => ({ code: CODE, raw: '' }))
    const verify = async (): Promise<Verdict> => ({ success: true, critique: '' })
    const r = await attemptObjective('mine coal', '', { ...base, generateCode, verify })
    expect(r.success).toBe(true)
    expect(r.attempts).toBe(1)
  })

  it('retries with the critique then succeeds, threading feedback', async () => {
    const inputs: GenerateCodeInput[] = []
    const generateCode = async (input: GenerateCodeInput) => {
      inputs.push(input)
      return { code: CODE, raw: '' }
    }
    let n = 0
    const verify = async (): Promise<Verdict> => (++n >= 2 ? { success: true, critique: '' } : { success: false, critique: 'need 5 more coal' })
    const r = await attemptObjective('mine coal', '', { ...base, generateCode, verify })
    expect(r.success).toBe(true)
    expect(r.attempts).toBe(2)
    const second = inputs[1]
    expect(second?.lastCritique).toBe('need 5 more coal')
    expect(second?.prevCode).toBe(CODE)
  })

  it('gives up after maxRetries when never approved', async () => {
    const generateCode = async () => ({ code: CODE, raw: '' })
    const verify = async (): Promise<Verdict> => ({ success: false, critique: 'no' })
    const r = await attemptObjective('x', '', { ...base, generateCode, verify, maxRetries: 3 })
    expect(r.success).toBe(false)
    expect(r.attempts).toBe(3)
  })

  it('keeps retrying when no code can be extracted', async () => {
    const generateCode = async () => ({ code: null, raw: 'sorry' })
    const verify = vi.fn(async (): Promise<Verdict> => ({ success: false, critique: 'no' }))
    const r = await attemptObjective('x', '', { ...base, generateCode, verify, maxRetries: 2 })
    expect(r.success).toBe(false)
    // verify is never called when there is no code to run
    expect(verify).not.toHaveBeenCalled()
  })
})

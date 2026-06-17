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
    walkTo: ok,
    mineEntity: ok,
    moveItems: ok,
    craftItem: ok,
    setRecipe: ok,
    buildSteamPower: async () => ({ ok: true }),
    researchTechnology: ok,
    wait: ok,
    attackNearestEnemy: ok,
    skill: ok,
    placeAt: ok,
    scan: async () => ({ entities: [], resources: {} }),
    renderMap: async () => null,
    getRecipe: async () => null,
    describeEntity: async () => null,
    findNearest: async () => null,
    placementSpots: async () => ({ spots: [] }),
    placeDrillOn: async () => ({ ok: true }),
    placeFurnaceAtDrill: async () => ({ ok: true }),
    placeBeltLine: async () => ({ ok: true }),
    placeInserterBetween: async () => ({ ok: true }),
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
  // These tests exercise the LLM-critic path (threading/retry/give-up), so opt out
  // of the deterministic pre-critic; its own short-circuit is covered separately below.
  deterministicCritic: false as const,
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

  it('reuses the post-run scan as the next attempt local map (skips the retry pre-scan)', async () => {
    const captureScan = vi.fn(async () => ({ entities: [{ name: 'stone-furnace', type: 'furnace', x: 0, y: 0, direction: 'north', status: 'no_fuel' }], resources: {} }))
    const localMaps: Array<string | null | undefined> = []
    const generateCode = async (input: GenerateCodeInput) => {
      localMaps.push(input.localMap)
      return { code: CODE, raw: '' }
    }
    let n = 0
    const verify = async (): Promise<Verdict> => (++n >= 2 ? { success: true, critique: '' } : { success: false, critique: 'no' })
    const r = await attemptObjective('mine coal', '', { ...base, captureScan, generateCode, verify, maxRetries: 2 })
    expect(r.attempts).toBe(2)
    // pre-scan(1) + post-scan(1) + post-scan(2) = 3 — attempt 2's pre-scan is the reused post-run scan, not a 4th call.
    expect(captureScan).toHaveBeenCalledTimes(3)
    // The retry's local map carries the post-run machine status the critic just judged.
    expect(localMaps[1]).toContain('no_fuel')
  })

  it('routes to the fast model for early attempts then escalates to the capable model', async () => {
    const models: string[] = []
    const generateCode = async (input: GenerateCodeInput) => {
      models.push(input.model)
      return { code: CODE, raw: '' }
    }
    const verify = async (): Promise<Verdict> => ({ success: false, critique: 'no' })
    await attemptObjective('x', '', { ...base, actionModel: 'big', fastActionModel: 'fast', modelEscalateAfter: 2, generateCode, verify, maxRetries: 4 })
    // Attempts 1-2 use the fast model, 3-4 escalate to the capable one.
    expect(models).toEqual(['fast', 'fast', 'big', 'big'])
  })

  it('uses the capable model for every attempt when no fast model is configured', async () => {
    const models: string[] = []
    const generateCode = async (input: GenerateCodeInput) => {
      models.push(input.model)
      return { code: CODE, raw: '' }
    }
    const verify = async (): Promise<Verdict> => ({ success: false, critique: 'no' })
    await attemptObjective('x', '', { ...base, actionModel: 'big', generateCode, verify, maxRetries: 3 })
    expect(models).toEqual(['big', 'big', 'big'])
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

  it('bounces sandbox-forbidden code before running, threading the reason to the retry', async () => {
    const inputs: GenerateCodeInput[] = []
    const generateCode = async (input: GenerateCodeInput) => {
      inputs.push(input)
      // First attempt uses a forbidden global; second is clean so it can pass the critic.
      return { code: inputs.length === 1 ? 'async function f(s, o){ require("fs") }' : CODE, raw: '' }
    }
    const verify = vi.fn(async (): Promise<Verdict> => ({ success: true, critique: '' }))
    const r = await attemptObjective('mine coal', '', { ...base, generateCode, verify, maxRetries: 2 })
    expect(r.success).toBe(true)
    expect(r.attempts).toBe(2)
    // verify ran only for the second (clean) attempt — the first was rejected before running.
    expect(verify).toHaveBeenCalledTimes(1)
    expect(inputs[1]?.lastError).toContain('sandbox')
  })

  it('settles a mechanical objective via the deterministic pre-critic (no LLM critic call)', async () => {
    // before = {}, after = { coal: 5 } -> "mine 5 coal" passes in code, verify must NOT run.
    let n = 0
    const captureState = async (): Promise<GameState> => (n++ === 0 ? state : { tick: 1, inventory: { coal: 5 }, entities: {} })
    const generateCode = async () => ({ code: CODE, raw: '' })
    const verify = vi.fn(async (): Promise<Verdict> => ({ success: false, critique: 'should not be called' }))
    const r = await attemptObjective('mine 5 coal', '', { ...base, deterministicCritic: true, captureState, generateCode, verify })
    expect(r.success).toBe(true)
    expect(r.attempts).toBe(1)
    expect(verify).not.toHaveBeenCalled()
  })
})

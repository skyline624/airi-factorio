import { describe, expect, it } from 'vitest'
import { dispatchIntent } from './intent-dispatcher'
import { lintSkillCode } from './lint'

describe('dispatchIntent', () => {
  it('produces an async function that calls the named primitive with the given args', () => {
    const { code } = dispatchIntent({ verb: 'automateResource', args: ['iron-ore'] })
    expect(code).toMatch(/async function/)
    expect(code).toContain('ops.automateResource(')
    expect(code).toContain('iron-ore')
  })

  it('serialises multiple / array args (buildChain recipe + inputs array)', () => {
    const { code } = dispatchIntent({ verb: 'buildChain', args: ['iron-gear-wheel', ['iron-plate']] })
    expect(code).toContain('ops.buildChain(')
    expect(code).toContain('iron-gear-wheel')
    expect(code).toContain('iron-plate')
    // The inputs array is JSON-serialised as an array literal in the call.
    expect(code).toMatch(/\[.*iron-plate.*\]/)
  })

  it('handles a no-arg primitive (buildSteamPower)', () => {
    const { code } = dispatchIntent({ verb: 'buildSteamPower', args: [] })
    expect(code).toContain('ops.buildSteamPower()')
  })

  it('throws on a primitive !ok result — so a built-but-not-running machine fails the run loudly', () => {
    const { code } = dispatchIntent({ verb: 'buildSteamPower', args: [] })
    expect(code).toMatch(/if \(res && !res\.ok\) throw/)
  })

  it('produces code that passes the static lint (no hardcoded coords, no forbidden globals)', () => {
    const { code } = dispatchIntent({ verb: 'automateResource', args: ['iron-ore'] })
    expect(code).toBeTruthy()
    const lint = lintSkillCode(code as string)
    expect(lint.hardError).toBeUndefined()
  })

  it('produces code that passes the lint for buildChain too (array args, no coords)', () => {
    const { code } = dispatchIntent({ verb: 'buildChain', args: ['electronic-circuit', ['iron-plate', 'copper-plate']] })
    expect(code).toBeTruthy()
    const lint = lintSkillCode(code as string)
    expect(lint.hardError).toBeUndefined()
  })
})

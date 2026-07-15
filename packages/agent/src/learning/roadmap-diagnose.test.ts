import type { Rung } from './roadmap'
import type { ScanEntity, ScanResult } from './types'
import { describe, expect, it } from 'vitest'
import { ROADMAP } from './roadmap'
import { diagnoseRung } from './roadmap-diagnose'

function entity(name: string, status: string, extra: Partial<ScanEntity> = {}): ScanEntity {
  return { name, type: name, x: 0, y: 0, direction: 'north', status, ...extra }
}
function scan(entities: ScanEntity[]): ScanResult {
  return { entities, resources: {} }
}
function rung(id: string): Rung {
  const r = ROADMAP.find(x => x.id === id)
  if (!r) {
    throw new Error(`no rung ${id}`)
  }
  return r
}

describe('diagnoseRung', () => {
  it('automateResource: retries when no drill exists yet (the primitive will place one)', () => {
    const r = diagnoseRung(rung('iron'), scan([]))
    expect(r.retry).toBe(true)
  })

  it('automateResource: retries when the drill is no_fuel (idempotent refuel)', () => {
    const r = diagnoseRung(rung('iron'), scan([entity('burner-mining-drill', 'no_fuel', { type: 'mining-drill', mining: 'iron-ore' })]))
    expect(r.retry).toBe(true)
    expect(r.reason).toContain('no_fuel')
  })

  it('buildSteamPower: retries when no engine exists yet, but YIELDS when one exists but is not working (no stacking)', () => {
    expect(diagnoseRung(rung('steam'), scan([])).retry).toBe(true)
    const r = diagnoseRung(rung('steam'), scan([entity('steam-engine', 'no_water', { type: 'generator' })]))
    expect(r.retry).toBe(false)
    expect(r.reason).toContain('steam-engine')
  })

  it('connectPowerTo: retries only if a steam-engine exists', () => {
    expect(diagnoseRung(rung('pole'), scan([entity('steam-engine', 'working', { type: 'generator' })])).retry).toBe(true)
    expect(diagnoseRung(rung('pole'), scan([])).retry).toBe(false)
  })

  it('buildChain: retries only if a pole exists (electricity), yields otherwise', () => {
    expect(diagnoseRung(rung('gears'), scan([entity('small-electric-pole', 'working', { type: 'electric-pole' })])).retry).toBe(true)
    expect(diagnoseRung(rung('gears'), scan([])).retry).toBe(false)
  })
})

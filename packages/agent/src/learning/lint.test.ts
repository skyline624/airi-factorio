import { describe, expect, it } from 'vitest'
import { lintSkillCode } from './lint'

describe('lintSkillCode', () => {
  it('passes clean skill code with no hard error and no hints', () => {
    const code = 'async function f(state, ops) { const m = await ops.renderMap(10); await ops.placeAt("stone-furnace", { x: 1, y: 1 }) }'
    const r = lintSkillCode(code)
    expect(r.hardError).toBeUndefined()
    expect(r.hints).toEqual([])
  })

  it('hard-errors on require()', () => {
    const r = lintSkillCode('async function f(state, ops) { const fs = require("fs") }')
    expect(r.hardError).toContain('require()')
  })

  it('hard-errors on an ES import statement', () => {
    const r = lintSkillCode('import x from "y"\nasync function f(state, ops) {}')
    expect(r.hardError).toContain('import')
  })

  it('hard-errors on fetch() and timers', () => {
    expect(lintSkillCode('async function f(s, o) { await fetch("http://x") }').hardError).toContain('fetch()')
    expect(lintSkillCode('async function f(s, o) { setTimeout(() => {}, 10) }').hardError).toContain('timers')
  })

  it('hard-errors on process access', () => {
    expect(lintSkillCode('async function f(s, o) { return process.env.X }').hardError).toContain('process')
  })

  it('hints when ops is called but never awaited', () => {
    const r = lintSkillCode('async function f(state, ops) { ops.mineEntity("coal", 5) }')
    expect(r.hardError).toBeUndefined()
    expect(r.hints.join(' ')).toContain('await')
  })

  it('hints when placeAt is used without reading the map first', () => {
    const r = lintSkillCode('async function f(state, ops) { await ops.placeAt("stone-furnace", { x: 1, y: 1 }) }')
    expect(r.hints.join(' ')).toContain('placeAt')
  })

  it('does NOT hint about blind placement when the map is read', () => {
    const r = lintSkillCode('async function f(state, ops) { await ops.scan(12); await ops.placeAt("stone-furnace", { x: 1, y: 1 }) }')
    expect(r.hints).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'
import { lintSkillCode } from './lint'

describe('lintSkillCode', () => {
  it('passes clean skill code (coords derived from a live read) with no hard error and no hints', () => {
    const code = 'async function f(state, ops) { const s = await ops.scan(10); const e = s.entities[0]; await ops.placeAt("stone-furnace", { x: e.x, y: e.y }) }'
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

  it('hints when placeAt is used without reading the map first (coords from a variable)', () => {
    const r = lintSkillCode('async function f(state, ops) { await ops.placeAt("stone-furnace", { x: pos.x, y: pos.y }) }')
    expect(r.hardError).toBeUndefined()
    expect(r.hints.join(' ')).toContain('placeAt')
  })

  it('does NOT hint about blind placement when the map is read (coords from scan)', () => {
    const r = lintSkillCode('async function f(state, ops) { const s = await ops.scan(12); await ops.placeAt("stone-furnace", { x: s.entities[0].x, y: s.entities[0].y }) }')
    expect(r.hints).toEqual([])
  })

  it('hard-errors on a hardcoded coordinate in walkTo', () => {
    const r = lintSkillCode('async function f(state, ops) { await ops.walkTo(5, -48) }')
    expect(r.hardError).toContain('hardcoded coordinate')
  })

  it('hard-errors on a hardcoded coordinate literal in placeAt', () => {
    const r = lintSkillCode('async function f(state, ops) { await ops.placeAt("iron-chest", { x: 8, y: -50 }) }')
    expect(r.hardError).toContain('hardcoded coordinate')
  })

  it('does NOT flag legit numeric args (wait/scan/mineEntity counts) or runtime-derived coords', () => {
    const code = 'async function f(state, ops) { await ops.wait(180); await ops.scan(12); await ops.mineEntity("coal", 20); const c = await ops.findNearest("coal"); await ops.walkTo(c.x, c.y) }'
    const r = lintSkillCode(code)
    expect(r.hardError).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'
import { extractJsonObject, extractLastJsonLine, parseJsonLoose } from './json'

describe('parseJsonLoose', () => {
  it('parses a clean object', () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 })
  })

  it('parses a bare array (op return value)', () => {
    expect(parseJsonLoose('[true,"Task started"]')).toEqual([true, 'Task started'])
  })

  it('recovers a fenced object', () => {
    expect(parseJsonLoose('```json\n{"ok":true}\n```')).toEqual({ ok: true })
  })

  it('recovers an object wrapped in prose', () => {
    expect(parseJsonLoose('Sure: {"x":2} done')).toEqual({ x: 2 })
  })

  it('returns null on junk, empty and nullish input', () => {
    expect(parseJsonLoose('hello')).toBeNull()
    expect(parseJsonLoose('')).toBeNull()
    expect(parseJsonLoose(null)).toBeNull()
    expect(parseJsonLoose(undefined)).toBeNull()
  })
})

describe('extractLastJsonLine', () => {
  it('recovers the printed JSON object past a command-echo line full of Lua braces', () => {
    const out = `2026-06-08 [COMMAND] <server> (command): local p=game.get_player(1) find_entities_filtered{force=p.force} rcon.print(tj({tick=game.tick}))\n{"tick":42,"inventory":{"ore":24}}`
    expect(extractLastJsonLine(out)).toEqual({ tick: 42, inventory: { ore: 24 } })
  })

  it('recovers a printed array (op return) past the echo', () => {
    const out = `2026 [COMMAND] <server> (command): local r={remote.call('autorio_operations','walk_to_entity','iron-ore',100)} rcon.print(tj(r))\n[true]`
    expect(extractLastJsonLine(out)).toEqual([true])
  })

  it('returns null when nothing parses', () => {
    expect(extractLastJsonLine('just a log line, no json')).toBeNull()
    expect(extractLastJsonLine('')).toBeNull()
  })
})

describe('extractJsonObject', () => {
  it('strips code fences down to the object', () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })
})

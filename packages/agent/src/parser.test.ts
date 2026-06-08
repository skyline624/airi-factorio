import { describe, expect, it } from 'vitest'
import { parseChatMessage, parseCommandMessage, parseLLMMessage, parseModErrorMessage, parseOperationCompletedMessage, parsePlayerEventMessage } from './parser'

describe('parseCommandMessage', () => {
  it('should parse player command', () => {
    const log = `2025-02-02 11:53:37 [COMMAND] username (command): remote.call("autorio_tools", "get_inventory_items", 1)`
    const result = parseCommandMessage(log)
    expect(result).toEqual({
      username: 'username',
      command: `remote.call("autorio_tools", "get_inventory_items", 1)`,
      isServer: false,
      date: '2025-02-02',
      type: 'command',
    })
  })

  it('should parse server command', () => {
    const log = `2025-02-02 12:03:17 [COMMAND] <server> (command): remote.call(\"autorio_tools\", \"get_inventory_items\", 1)`
    const result = parseCommandMessage(log)
    expect(result).toEqual({
      username: 'server',
      command: `remote.call("autorio_tools", "get_inventory_items", 1)`,
      isServer: true,
      date: '2025-02-02',
      type: 'command',
    })
  })
})

describe('parseChatMessage', () => {
  it('should parse chat message', () => {
    const log = `2025-02-02 11:53:37 [CHAT] username: hello world`
    const result = parseChatMessage(log)
    expect(result).toEqual({
      username: 'username',
      message: 'hello world',
      isServer: false,
      date: '2025-02-02',
      type: 'chat',
    })
  })

  it('should parse server chat message', () => {
    const log = `2025-02-02 11:53:37 [CHAT] <server>: hello world`
    const result = parseChatMessage(log)
    expect(result).toEqual({
      username: 'server',
      message: 'hello world',
      isServer: true,
      date: '2025-02-02',
      type: 'chat',
    })
  })
})

describe('parseModErrorMessage', () => {
  it('should parse mod error message', () => {
    const log = `42.535 Script @__autorio__/control.lua:661: [AUTORIO] [ERROR] No iron-ore found in 50m radius, reverting to IDLE state`
    const result = parseModErrorMessage(log)
    expect(result).toEqual({
      error: 'No iron-ore found in 50m radius, reverting to IDLE state',
      serverTimestamp: '42.535',
      type: 'modError',
    })
  })
})

describe('parseOperationCompletedMessage', () => {
  it('should parse operation completed message', () => {
    const log = `51.889 Script @__autorio__/control.lua:920: [AUTORIO] All operations completed`
    const result = parseOperationCompletedMessage(log)
    expect(result).toEqual({
      serverTimestamp: '51.889',
      type: 'operationsCompleted',
    })
  })
})

describe('parseLLMMessage', () => {
  it('should parse a raw JSON object', () => {
    const result = parseLLMMessage(`{"chatMessage":"hi","operationCommands":[],"plan":[],"currentStep":0}`)
    expect(result.chatMessage).toBe('hi')
    expect(result.operationCommands).toEqual([])
  })

  it('should parse JSON wrapped in markdown code fences', () => {
    const wrapped = '```json\n{"chatMessage":"hi","operationCommands":[],"plan":[],"currentStep":0}\n```'
    const result = parseLLMMessage(wrapped)
    expect(result.chatMessage).toBe('hi')
  })

  it('should recover a JSON object surrounded by prose', () => {
    const noisy = `Sure! Here you go:\n{"chatMessage":"ok","operationCommands":["a"],"plan":[],"currentStep":1}\nhope that helps`
    const result = parseLLMMessage(noisy)
    expect(result.chatMessage).toBe('ok')
    expect(result.currentStep).toBe(1)
  })
})

describe('parsePlayerEventMessage', () => {
  it('should parse a damaged event with fields', () => {
    const log = `42.535 Script @__autorio__/control.lua:200: [AUTORIO] [EVENT] damaged health=80 max_health=100 ratio=0.8 cause=small-biter damage_type=physical`
    const result = parsePlayerEventMessage(log)
    expect(result?.type).toBe('playerEvent')
    expect(result?.eventType).toBe('damaged')
    expect(result?.fields.health).toBe('80')
    expect(result?.fields.cause).toBe('small-biter')
  })

  it('should parse an enemies_spotted event', () => {
    const log = `51.000 Script @__autorio__/control.lua:210: [AUTORIO] [EVENT] enemies_spotted count=3 nearest=small-biter distance=12`
    const result = parsePlayerEventMessage(log)
    expect(result?.eventType).toBe('enemies_spotted')
    expect(result?.fields.count).toBe('3')
    expect(result?.fields.distance).toBe('12')
  })

  it('should parse an event without fields', () => {
    const log = `60.000 Script @__autorio__/control.lua:220: [AUTORIO] [EVENT] enemies_cleared`
    const result = parsePlayerEventMessage(log)
    expect(result?.eventType).toBe('enemies_cleared')
    expect(result?.fields).toEqual({})
  })

  it('should return null for a non-event log line', () => {
    const log = `42.535 Script @__autorio__/control.lua:661: [AUTORIO] [ERROR] something happened`
    expect(parsePlayerEventMessage(log)).toBeNull()
  })
})

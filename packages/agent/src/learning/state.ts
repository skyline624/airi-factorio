import type { GameState, ScanEntity, ScanResult } from './types'
import { extractLastJsonLine } from './json'

// Lua-level player resolver shared by the state-capture snippet and the
// vision screenshot snippet. Strategy: explicit name (if non-empty) → first
// connected player → game.get_player(1) (legacy fallback, kept so the
// prefix echoed by RCON still contains `get_player(1)` for test parsers).
//
// `playerName` is injected as a Lua string literal; we escape it defensively
// against a `'`, `\`, or newline/CR sneaking in via env vars (a bare newline or
// CR would otherwise break the single-line `/c` command).
function luaString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}'`
}

export function buildPlayerResolveSnippet(playerName: string): string {
  return `local TARGET=${luaString(playerName)} local function resolve() if TARGET and TARGET~='' then for _,q in pairs(game.players) do if q.valid and q.name==TARGET then return q end end end for _,q in pairs(game.players) do if q.valid and q.connected then return q end end return game.get_player(1) end`
}

// A self-contained Lua snippet that defines `local function getstate()` returning
// the compact world snapshot as a table. Factored out so the SAME state-gathering
// can be printed alone (capture-state) or embedded in a single batched command
// alongside scan_factory + production_stats (one RCON round-trip instead of three).
// `helpers.table_to_json` is the Factorio 2.0 API (older saves expose
// `game.table_to_json`); we pick whichever exists.
function buildStateFnSnippet(playerName: string): string {
  return `${buildPlayerResolveSnippet(playerName)} local function getstate() local p=resolve() if not p then return {} end local inv={} local m=p.get_main_inventory() if m then for _,c in pairs(m.get_contents()) do inv[c.name]=(inv[c.name] or 0)+c.count end end local ent={} for _,e in pairs(p.surface.find_entities_filtered{force=p.force,position=p.position,radius=200}) do if e.name~='character' then ent[e.name]=(ent[e.name] or 0)+1 end end local rs=nil if p.force.current_research then rs=p.force.current_research.name end local tc=0 for _,t in pairs(p.force.technologies) do if t.researched then tc=tc+1 end end local ch=p.character return {tick=game.tick,position=p.position,health=ch and ch.health or nil,max_health=ch and ch.max_health or nil,inventory=inv,entities=ent,current_research=rs,researched_count=tc} end`
}

function buildCaptureBody(playerName: string): string {
  return `${buildStateFnSnippet(playerName)} local tj=helpers and helpers.table_to_json or game.table_to_json rcon.print(tj(getstate()))`
}

// One command that returns the post-run trio — player state + factory census
// (scan_factory) + production counters (production_stats) — as a single JSON
// `{state,scan,production}`. Each tool call is pcall-guarded so a missing remote
// interface yields nil rather than aborting the whole capture.
function buildBatchedCaptureBody(playerName: string): string {
  return `${buildStateFnSnippet(playerName)} local function jcall(n) local ok,r=pcall(remote.call,'autorio_tools',n) if ok then return r else return nil end end local tj=helpers and helpers.table_to_json or game.table_to_json rcon.print(tj({state=getstate(),scan=jcall('scan_factory'),production=jcall('production_stats')}))`
}

export const CAPTURE_STATE_COMMAND = `/c ${buildCaptureBody('')}`

/** Build a `/c` command that captures the world for the given player name (or auto-detect if empty). */
export function buildCaptureStateCommand(playerName: string): string {
  return `/c ${buildCaptureBody(playerName)}`
}

/** Build a `/c` command that captures state + factory census + production counters in ONE round-trip. */
export function buildBatchedCaptureCommand(playerName: string): string {
  return `/c ${buildBatchedCaptureBody(playerName)}`
}

/**
 * Build a `/c` command that probes whether the agent's target player is actually
 * IN-GAME with a character to control — prints 'READY' or 'WAIT'. A dedicated server
 * has no character (and barely ticks) until a client connects, so the agent must
 * gate on this before driving any character op, or every op would time out.
 */
export function buildPlayerPresenceCommand(playerName: string): string {
  return `/c ${buildPlayerResolveSnippet(playerName)} local p=resolve() rcon.print((p~=nil and p.connected==true and p.character~=nil) and 'READY' or 'WAIT')`
}

/** Build a `/c` command that takes a screenshot from the given player's POV. */
export function buildScreenshotCommand(shot: string, playerName: string): string {
  return `/c ${buildPlayerResolveSnippet(playerName)} local p=resolve(); if p and p.connected then game.take_screenshot{by_player=p, position=p.position, resolution={384,384}, zoom=0.5, path='${shot}', show_gui=false, show_entity_info=true} end`
}

/** An empty Lua table may serialise as `[]` (depending on version); treat arrays and junk as an empty record. */
function asCountRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const out: Record<string, number> = {}
  for (const [key, n] of Object.entries(value as Record<string, unknown>)) {
    if (typeof n === 'number') {
      out[key] = n
    }
  }
  return out
}

function gameStateFromRaw(raw: Record<string, unknown>): GameState {
  let position: { x: number, y: number } | undefined
  if (raw.position && typeof raw.position === 'object' && !Array.isArray(raw.position)) {
    const p = raw.position as { x?: unknown, y?: unknown }
    position = { x: Number(p.x) || 0, y: Number(p.y) || 0 }
  }

  return {
    tick: typeof raw.tick === 'number' ? raw.tick : 0,
    position,
    health: typeof raw.health === 'number' ? raw.health : undefined,
    maxHealth: typeof raw.max_health === 'number' ? raw.max_health : undefined,
    inventory: asCountRecord(raw.inventory),
    entities: asCountRecord(raw.entities),
    currentResearch: typeof raw.current_research === 'string' ? raw.current_research : undefined,
    researchedCount: typeof raw.researched_count === 'number' ? raw.researched_count : undefined,
  }
}

export function parseGameState(output: string): GameState {
  return gameStateFromRaw(extractLastJsonLine<Record<string, unknown>>(output) ?? {})
}

/** Capture the current world state via a raw `/c` command and the given RCON sender. */
export async function captureState(raw: (input: string) => Promise<string>, playerName?: string): Promise<GameState> {
  return parseGameState(await raw(buildCaptureStateCommand(playerName ?? '')))
}

function diffRecord(before: Record<string, number>, after: Record<string, number>): { gained: string[], lost: string[] } {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const gained: string[] = []
  const lost: string[] = []
  for (const key of [...keys].sort()) {
    const delta = (after[key] ?? 0) - (before[key] ?? 0)
    if (delta > 0) {
      gained.push(`${key} +${delta}`)
    }
    else if (delta < 0) {
      lost.push(`${key} ${delta}`)
    }
  }
  return { gained, lost }
}

/** A concise, human-readable before→after delta for the critic to judge against. */
export function diffState(before: GameState, after: GameState): string {
  const lines: string[] = []

  const inv = diffRecord(before.inventory, after.inventory)
  lines.push(`Inventory gained: ${inv.gained.join(', ') || '(none)'}`)
  if (inv.lost.length) {
    lines.push(`Inventory consumed/lost: ${inv.lost.join(', ')}`)
  }

  const ent = diffRecord(before.entities, after.entities)
  lines.push(`Entities built: ${ent.gained.join(', ') || '(none)'}`)
  if (ent.lost.length) {
    lines.push(`Entities removed/destroyed: ${ent.lost.join(', ')}`)
  }

  if (before.currentResearch !== after.currentResearch) {
    lines.push(`Research changed: ${before.currentResearch ?? 'none'} -> ${after.currentResearch ?? 'none'}`)
  }
  if ((after.researchedCount ?? 0) !== (before.researchedCount ?? 0)) {
    lines.push(`Technologies researched: ${before.researchedCount ?? 0} -> ${after.researchedCount ?? 0}`)
  }
  if (before.health !== undefined && after.health !== undefined && before.health !== after.health) {
    lines.push(`Health: ${before.health} -> ${after.health}`)
  }

  return lines.join('\n')
}

function scanFromRaw(raw: Record<string, unknown>): ScanResult {
  const entities: ScanEntity[] = []
  if (Array.isArray(raw.entities)) {
    for (const item of raw.entities as unknown[]) {
      if (item && typeof item === 'object') {
        const e = item as Record<string, unknown>
        const ent: ScanEntity = {
          name: typeof e.name === 'string' ? e.name : 'unknown',
          type: typeof e.type === 'string' ? e.type : 'unknown',
          x: Number(e.x) || 0,
          y: Number(e.y) || 0,
          direction: typeof e.direction === 'string' ? e.direction : 'north',
          status: typeof e.status === 'string' ? e.status : 'n/a',
        }
        // Drills carry mining (the resource actually mined) + oreUnder (ore left in range).
        // These were dropped before — so the curriculum/critic never saw what a drill mines.
        if (typeof e.mining === 'string') {
          ent.mining = e.mining
        }
        if (typeof e.oreUnder === 'number') {
          ent.oreUnder = e.oreUnder
        }
        entities.push(ent)
      }
    }
  }

  const resources: Record<string, { count: number, x: number, y: number }> = {}
  if (raw.resources && typeof raw.resources === 'object' && !Array.isArray(raw.resources)) {
    for (const [key, value] of Object.entries(raw.resources as Record<string, unknown>)) {
      if (value && typeof value === 'object') {
        const o = value as Record<string, unknown>
        resources[key] = { count: Number(o.count) || 0, x: Number(o.x) || 0, y: Number(o.y) || 0 }
      }
    }
  }

  let origin: { x: number, y: number } | undefined
  if (raw.origin && typeof raw.origin === 'object' && !Array.isArray(raw.origin)) {
    const o = raw.origin as { x?: unknown, y?: unknown }
    origin = { x: Number(o.x) || 0, y: Number(o.y) || 0 }
  }

  return {
    origin,
    radius: typeof raw.radius === 'number' ? raw.radius : undefined,
    entities,
    resources,
  }
}

/** Parse the JSON reply from the `scan_area`/`scan_factory` tool into a structured local map. */
export function parseScan(output: string): ScanResult {
  return scanFromRaw(extractLastJsonLine<Record<string, unknown>>(output) ?? {})
}

/** A post-run snapshot captured in ONE RCON round-trip: state + factory census + production counters. */
export interface BatchedCapture {
  state: GameState
  scan: ScanResult
  production: Record<string, number> | null
}

/** Parse the combined `{state,scan,production}` JSON from `buildBatchedCaptureCommand`. */
export function parseBatchedCapture(output: string): BatchedCapture {
  const raw = extractLastJsonLine<Record<string, unknown>>(output) ?? {}
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v)) ? v as Record<string, unknown> : {}
  let production: Record<string, number> | null = null
  const prod = obj(raw.production)
  if (prod.produced && typeof prod.produced === 'object') {
    production = asCountRecord(prod.produced)
  }
  return {
    state: gameStateFromRaw(obj(raw.state)),
    scan: scanFromRaw(obj(raw.scan)),
    production,
  }
}

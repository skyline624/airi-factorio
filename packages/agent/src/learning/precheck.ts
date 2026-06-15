import type { GameState } from './types'

/**
 * A deterministic pre-critic. Many objectives are MECHANICAL — "mine 20 iron
 * ore", "build a furnace", "research automation" — and their verdict is a pure
 * function of the before/after state diff, with no judgement needed. Deciding
 * those in code (a) skips a 5–90 s critic-LLM round-trip and (b) cannot
 * hallucinate. Anything ambiguous (status-laden "automate X", a started-but-
 * unfinished research, a non-mechanical "find/scout X") returns `decided:false`
 * so the LLM critic (`verify`) judges it exactly as before.
 *
 * Safety bias: SUCCESS is only ever returned on a strong, grounded, positive
 * signal (the target item/entity/tech actually moved by the required amount);
 * FAILURE is only returned on a naming-independent no-op (literally NOTHING
 * changed anywhere). Everything in between defers to the LLM.
 */
export interface PrecheckInput {
  objective: string
  before: GameState
  after: GameState
  /** Force-wide production counters at objective start / end (counts items MADE even if then consumed). */
  prodBefore?: Record<string, number> | null
  prodAfter?: Record<string, number> | null
}

export interface PrecheckResult {
  /** true = the verdict is settled in code; false = defer to the LLM critic. */
  decided: boolean
  success?: boolean
  critique?: string
  reasoning?: string
}

// Verbs whose outcome is reliably reflected in a concrete state delta.
const ACQUIRE_RE = /\b(mine|mined|mining|collect|gather|gathered|harvest|craft|crafted|make|made|smelt|produce|obtain|accumulate|stockpile)\b/
const BUILD_RE = /\b(build|built|place|placed|construct|deploy|lay)\b/
const RESEARCH_RE = /\bresearch(?:ed|ing)?\b/
// Status-laden words mean a machine STATUS judgement is needed (working / powered /
// fed) — never decide those in code even if a build/acquire verb is also present.
const STATUS_RE = /\b(automate|automated|automating|working|powered|electricity|feeds?|feeding|running|online)\b/

/** Lowercased, hyphen→space, punctuation-stripped form for substring matching against diff keys. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Positive deltas only (what was GAINED) from two count records. */
function positiveDeltas(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(after)) {
    const delta = count - (before[key] ?? 0)
    if (delta > 0) {
      out[key] = delta
    }
  }
  return out
}

/** The first gained key whose de-hyphenated name appears in the objective, with delta ≥ need. */
function matchGain(gained: Record<string, number>, normObjective: string, need: number): { key: string, delta: number } | null {
  for (const [key, delta] of Object.entries(gained)) {
    if (delta >= need && normObjective.includes(key.replace(/-/g, ' '))) {
      return { key, delta }
    }
  }
  return null
}

export function precheckVerdict(input: PrecheckInput): PrecheckResult {
  const norm = normalize(input.objective)

  // A machine-status objective is a judgement call — hand it to the LLM critic.
  if (STATUS_RE.test(norm)) {
    return { decided: false }
  }

  const invGained = positiveDeltas(input.before.inventory, input.after.inventory)
  const entGained = positiveDeltas(input.before.entities, input.after.entities)
  const prodGained = (input.prodBefore && input.prodAfter) ? positiveDeltas(input.prodBefore, input.prodAfter) : {}
  const researchCompleted = (input.after.researchedCount ?? 0) > (input.before.researchedCount ?? 0)
  const researchChanged = input.before.currentResearch !== input.after.currentResearch

  const anyPositive
    = Object.keys(invGained).length > 0
      || Object.keys(entGained).length > 0
      || Object.keys(prodGained).length > 0
      || researchCompleted
      || researchChanged

  // The naming-independent no-op: NOTHING moved. Safe to fail any mechanical objective.
  const noop = !anyPositive

  // Count of the target, if the objective states one (e.g. "mine 20 iron ore" -> 20).
  const numMatch = norm.match(/\b(\d+)\b/)
  const stated = numMatch ? Number.parseInt(numMatch[1], 10) : null

  // RESEARCH: success only on a COMPLETED tech (count up); a started-but-unfinished
  // research (currentResearch changed, count same) is for the LLM to judge.
  if (RESEARCH_RE.test(norm)) {
    if (researchCompleted) {
      return { decided: true, success: true, critique: '', reasoning: 'a technology completed (researchedCount increased)' }
    }
    if (noop) {
      return { decided: true, success: false, critique: 'No technology completed. Ensure a powered lab with science packs, then research.', reasoning: 'no state change' }
    }
    return { decided: false }
  }

  // BUILD: success when the named entity count rose by the stated amount (default 1).
  if (BUILD_RE.test(norm)) {
    const need = stated ?? 1
    const hit = matchGain(entGained, norm, need)
    if (hit) {
      return { decided: true, success: true, critique: '', reasoning: `entity ${hit.key} +${hit.delta} (need ${need})` }
    }
    if (noop) {
      return { decided: true, success: false, critique: 'No new entity was built. Read the map, walk within build reach, then placeAt with exact coordinates and check ok.', reasoning: 'no state change' }
    }
    return { decided: false }
  }

  // ACQUIRE: success when the named item was GAINED (inventory) or MADE (production)
  // by the stated amount (default 1). Production covers smelting whose output sits in
  // a furnace rather than the inventory.
  if (ACQUIRE_RE.test(norm)) {
    const need = stated ?? 1
    const hit = matchGain(invGained, norm, need) ?? matchGain(prodGained, norm, need)
    if (hit) {
      return { decided: true, success: true, critique: '', reasoning: `${hit.key} +${hit.delta} (need ${need})` }
    }
    if (noop) {
      return { decided: true, success: false, critique: 'Nothing was gained (inventory and production show no increase). Walk to the resource and mine/craft it, checking ok after each op.', reasoning: 'no state change' }
    }
    return { decided: false }
  }

  // Non-mechanical objective (find / scout / explore / unknown) — defer to the LLM.
  return { decided: false }
}

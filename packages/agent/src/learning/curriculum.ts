import type { GameState, SuccessCheck } from './types'
import curriculumPrompt from '../llm/prompt-curriculum.md?raw'
import { summarizeState } from './action'
import { complete } from './llm'

export interface CurriculumInput {
  ultimateGoal: string
  state: GameState
  /** Force-wide machine census (name/status/`mining`) — lets the curriculum SEE whether anything is automated yet. */
  factorySummary?: string
  /** Ore/resource patches within scan range + distance ("iron-ore x842 near (-88,-76) d0 …") — so the curriculum knows what is REACHABLE and stops proposing "go find iron" when the agent is already standing on it. */
  resourcesSummary?: string
  /** ASCII map of the local area (centred on the player), so the PLANNER sees spatial reality — like a general reading a map — not just text. Lets it catch e.g. a drill whose output tile (X) isn't covered by a furnace (broken feed), overlaps, free space. */
  mapView?: string
  /** Cumulative force production totals ("iron-plate: 62, …"). */
  productionSummary?: string
  skills: { name: string, description: string }[]
  completed: string[]
  /** Recently-failed objectives WITH their critique (why they failed), so the curriculum can fix the cause or pick a different prerequisite instead of re-proposing the same string. */
  failedDetails: { objective: string, critique: string }[]
  /** Objectives that failed repeatedly — the curriculum MUST NOT re-propose any of them (loop breaker). */
  forbidObjectives?: string[]
  model: string
  /** Injectable for tests; defaults to the real LLM completion. */
  complete?: typeof complete
}

export interface ProposedObjective {
  reasoning?: string
  objective: string
  context: string
  /** Machine-verifiable success criterion → the critic is fully deterministic (no LLM). Undefined if the curriculum gave none/malformed (the attempt falls back to the heuristic precheck). */
  successCheck?: SuccessCheck
}

/**
 * Parse a `Check:` line of the form `Check: <kind> [item|entity] [count]` into a SuccessCheck.
 * Examples: `Check: produce iron-plate 5` | `Check: acquire iron-ore 20` |
 *           `Check: build assembling-machine-1` | `Check: research`.
 * Returns undefined (→ the attempt falls back to the heuristic precheck) when the line is
 * absent or malformed — so the critic stays correct even if the model botches this one line.
 */
function parseCheckLine(rest: string): SuccessCheck | undefined {
  const parts = rest.trim().split(/\s+/)
  const kind = parts[0]
  if (kind !== 'acquire' && kind !== 'produce' && kind !== 'build' && kind !== 'research') {
    return undefined
  }
  if (kind === 'research') {
    return { kind: 'research' }
  }
  const target = parts[1] ?? ''
  if (!target) {
    return undefined
  }
  const countRaw = parts[2]
  const parsed = countRaw !== undefined ? Number.parseInt(countRaw, 10) : 1
  const raw = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 1
  // CLAMP the count to what ONE skill run can achieve — the model routinely ignores the prompt's
  // 1-5/1-20 caps and emits "produce iron-plate 30", which can NEVER pass in the retry budget and
  // loops the objective forever. Enforcing the cap in code (not prose) makes every check reachable.
  const cap = kind === 'produce' ? 5 : (kind === 'acquire' ? 20 : 1)
  const count = Math.min(raw, cap)
  const out: SuccessCheck = { kind, count }
  if (kind === 'build') {
    out.entity = target
  }
  else {
    out.item = target
  }
  return out
}

/**
 * Voyager-style line parser. Tolerant: looks for `Task:`, `Reasoning:`, `Context:`, `Check:`
 * labelled lines anywhere in the model's response — no JSON, no fences, no exact-order
 * requirement. If the model babbles around the labels, the Task line still parses. This is the
 * robustness Voyager gets and glm-5.2 fails to provide as JSON (it routes answers into its
 * reasoning channel / wraps JSON in prose). The Task line is REQUIRED; the rest optional.
 */
function parseLineObjective(content: string): { reasoning?: string, objective?: string, context: string, successCheck?: SuccessCheck } {
  const out: { reasoning?: string, objective?: string, context: string, successCheck?: SuccessCheck } = { context: '' }
  // Match a labelled line at start-of-line; capture the label and the rest of that line.
  // Multi-line values are NOT supported — each label is one line (Voyager convention).
  const labelRe = /^(Reasoning|Task|Context|Check)\s*:\s*(.*)$/i
  for (const raw of content.split(/\r?\n/)) {
    const m = raw.match(labelRe)
    if (!m) {
      continue
    }
    const value = (m[2] ?? '').trim()
    const label = m[1].toLowerCase()
    if (label === 'task') {
      out.objective = value
    }
    else if (label === 'reasoning') {
      out.reasoning = value
    }
    else if (label === 'context') {
      out.context = value
    }
    else if (label === 'check') {
      out.successCheck = parseCheckLine(value)
    }
  }
  return out
}

function buildMessage(input: CurriculumInput): string {
  const lines: string[] = [
    `ULTIMATE GOAL: ${input.ultimateGoal}`,
    '',
    'CURRENT STATE:',
    summarizeState(input.state),
    '',
    'FACTORY (every machine the force has built + status; a drill line shows what it `mining`s — this is your automation ground truth):',
    input.factorySummary ?? '(no factory data)',
    '',
    'NEARBY RESOURCES (ore patches within scan range + distance from you; d0 means you are STANDING ON it — propose placing a drill HERE, do NOT propose going to find it again):',
    input.resourcesSummary ?? '(no ore patches in scan range — an exploration objective is warranted)',
    '',
    'LOCAL MAP (ASCII, centred on you — READ IT like a general reads the battlefield before deciding):',
    input.mapView ?? '(no map available)',
    'Map-reading for objectives: an `X` is a drill OUTPUT tile that is NOT yet covered by a machine — if you see `D` with a nearby uncovered `X`, the drill is dropping ore on the GROUND (broken feed): propose ALIGNING a furnace/belt/chest onto that X, NOT collecting plates. A drill `D` whose output is covered by `F` is correctly feeding. Use the map to judge alignment, free space and what is actually built before proposing the next step.',
    '',
    `PRODUCTION TOTALS (cumulative, hand + machines): ${input.productionSummary ?? '(nothing produced yet)'}`,
  ]
  if (input.skills.length) {
    lines.push('', 'KNOWN SKILLS (compose / build on these when sensible):')
    for (const s of input.skills) {
      lines.push(`- ${s.name}: ${s.description}`)
    }
  }
  if (input.completed.length) {
    // Dedup (keep last occurrence) so the list carries info, not repeats.
    const doneUniq = [...new Set(input.completed)].slice(-12)
    lines.push('', `ALREADY DONE (do NOT repeat): ${doneUniq.join(' | ')}`)
  }
  if (input.failedDetails.length) {
    // Dedup by objective, keeping the LATEST critique — so a stuck objective appears ONCE with
    // its reason ("boiler had no water"), not the same string x6 with no new signal.
    const latest = new Map<string, string>()
    for (const f of input.failedDetails) {
      latest.set(f.objective, f.critique)
    }
    const rows = [...latest.entries()].slice(-6).map(([obj, crit]) => `"${obj}" → ${crit}`)
    lines.push('', 'RECENTLY FAILED (with WHY — FIX the stated cause, or pick a DIFFERENT prerequisite; do NOT re-propose the same objective):', ...rows)
  }
  if (input.forbidObjectives && input.forbidObjectives.length) {
    lines.push('', '⛔ FORBIDDEN — these objectives have FAILED repeatedly and are BANNED. Do NOT propose any of them or a near-rephrasing. Propose something DIFFERENT — a smaller prerequisite, a fix for the failure cause, or a DIFFERENT rung:')
    for (const o of input.forbidObjectives.slice(-8)) {
      lines.push(`- "${o}"`)
    }
  }
  lines.push('', 'Propose the next objective as labelled lines (see output format in the system prompt).')
  return lines.join('\n')
}

/** Propose the next objective toward the ultimate goal. Returns null if the LLM gives no usable objective. */
/**
 * Strip literal tile coordinates like "(-4, -46)" from an objective/context. The prompt forbids
 * coordinates (they go stale/wrong across maps and leak the decider's guess into the executor as
 * a false target), but the model emits them anyway — so we remove them in code. The executor
 * derives the real tile at runtime from renderMap/scan/findNearest.
 */
export function stripCoordinates(text: string): string {
  return text
    .replace(/\bat\s*\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/gi, 'at the right spot')
    .replace(/\(\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

export async function proposeNextObjective(input: CurriculumInput): Promise<ProposedObjective | null> {
  const call = input.complete ?? complete
  const content = await call({ system: curriculumPrompt, user: buildMessage(input), model: input.model })
  if (!content) {
    return null
  }
  const parsed = parseLineObjective(content)
  if (!parsed.objective || !parsed.objective.trim()) {
    return null
  }
  const objective = stripCoordinates(parsed.objective.trim())
  const context = stripCoordinates(parsed.context)
  return {
    reasoning: parsed.reasoning,
    objective,
    context,
    successCheck: parsed.successCheck,
  }
}

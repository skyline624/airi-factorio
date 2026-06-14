import type { GameState } from './types'
import curriculumPrompt from '../llm/prompt-curriculum.md?raw'
import { summarizeState } from './action'
import { parseJsonLoose } from './json'
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
  failed: string[]
  model: string
  /** Injectable for tests; defaults to the real LLM completion. */
  complete?: typeof complete
}

export interface ProposedObjective {
  reasoning?: string
  objective: string
  context: string
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
    lines.push('', `ALREADY DONE (do NOT repeat): ${input.completed.slice(-12).join(' | ')}`)
  }
  if (input.failed.length) {
    lines.push('', `RECENTLY FAILED (pick a simpler version or a prerequisite): ${input.failed.slice(-6).join(' | ')}`)
  }
  lines.push('', 'Propose the next objective as the JSON object.')
  return lines.join('\n')
}

/** Propose the next objective toward the ultimate goal. Returns null if the LLM gives no usable objective. */
export async function proposeNextObjective(input: CurriculumInput): Promise<ProposedObjective | null> {
  const call = input.complete ?? complete
  const content = await call({ system: curriculumPrompt, user: buildMessage(input), model: input.model })
  const parsed = parseJsonLoose<ProposedObjective>(content)
  if (!parsed || typeof parsed.objective !== 'string' || !parsed.objective.trim()) {
    return null
  }
  return {
    reasoning: parsed.reasoning,
    objective: parsed.objective.trim(),
    context: typeof parsed.context === 'string' ? parsed.context.trim() : '',
  }
}

import type { GameState } from './types'
import curriculumPrompt from '../llm/prompt-curriculum.md?raw'
import { summarizeState } from './action'
import { parseJsonLoose } from './json'
import { complete } from './llm'

export interface CurriculumInput {
  ultimateGoal: string
  state: GameState
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

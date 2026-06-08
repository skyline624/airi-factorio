import type { GameState, Verdict } from './types'
import criticPrompt from '../llm/prompt-critic.md?raw'
import { parseJsonLoose } from './json'
import { complete } from './llm'
import { diffState } from './state'

export interface VerifyOptions {
  objective: string
  before: GameState
  after: GameState
  logs?: string[]
  model: string
  /** Injectable for tests; defaults to the real LLM completion. */
  complete?: typeof complete
}

/**
 * Self-verification: ask an LLM whether the objective was achieved, judging from
 * the concrete state diff + the skill's own log. Replaces the naive "All
 * operations completed" success signal. On any failure to get a valid verdict it
 * returns success:false so the loop retries rather than wrongly learning a skill.
 */
export async function verify(options: VerifyOptions): Promise<Verdict> {
  const call = options.complete ?? complete
  const diff = diffState(options.before, options.after)

  const user = [
    `OBJECTIVE: ${options.objective}`,
    '',
    'STATE CHANGE (before -> after):',
    diff,
    '',
    'SKILL LOG (what the agent reported doing):',
    (options.logs && options.logs.length) ? options.logs.join('\n') : '(none)',
    '',
    'Did the agent achieve the objective? Reply with the JSON verdict only.',
  ].join('\n')

  const content = await call({ system: criticPrompt, user, model: options.model })
  const parsed = parseJsonLoose<Verdict>(content)
  if (!parsed || typeof parsed.success !== 'boolean') {
    return { success: false, critique: 'The critic could not produce a valid verdict; assume the objective is not yet met and retry.' }
  }
  return { reasoning: parsed.reasoning, success: parsed.success, critique: parsed.critique ?? '' }
}

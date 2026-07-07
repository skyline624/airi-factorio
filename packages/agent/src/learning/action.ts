import type { GameState, ScanResult } from './types'
import { createLogg } from '@guiiai/logg'
import actionPrompt from '../llm/prompt-action-code.md?raw'
import { complete } from './llm'

const logger = createLogg('action').useGlobalConfig()

export interface RetrievedSkill {
  name: string
  description: string
  code: string
}

export interface GenerateCodeInput {
  objective: string
  context?: string
  state: GameState
  skills?: RetrievedSkill[]
  prevCode?: string | null
  lastError?: string | null
  lastCritique?: string | null
  /** Static-analysis smells about the previous attempt (blind placement, missing await). */
  hints?: string[] | null
  /** What has already been achieved toward the objective (banked across retries). */
  progress?: string | null
  /** A compact spatial map (from ops.scan) so the LLM can place at exact coordinates. */
  localMap?: string | null
  model: string
  /** Injectable for tests; defaults to the real LLM completion. */
  complete?: typeof complete
}

export interface GeneratedCode {
  code: string | null
  raw: string
}

/** A compact, prompt-friendly view of the current state. */
export function summarizeState(state: GameState): string {
  const inv = Object.entries(state.inventory).map(([k, v]) => `${k}:${v}`).join(', ') || '(empty)'
  const ent = Object.entries(state.entities).map(([k, v]) => `${k}:${v}`).join(', ') || '(none)'
  const pos = state.position ? `(${Math.round(state.position.x)}, ${Math.round(state.position.y)})` : 'unknown'
  const health = (state.health !== undefined && state.maxHealth !== undefined)
    ? `${Math.round(state.health)}/${state.maxHealth}`
    : (state.health !== undefined ? `${Math.round(state.health)}` : 'unknown')
  return [
    `- inventory: ${inv}`,
    `- player-built entities nearby: ${ent}`,
    `- position: ${pos}`,
    `- health: ${health}`,
    `- researching: ${state.currentResearch ?? 'nothing'} (${state.researchedCount ?? 0} techs done)`,
  ].join('\n')
}

/** A compact, prompt-friendly local map from ops.scan — for exact-coordinate placement. */
export function summarizeScan(scan: ScanResult): string {
  const o = scan.origin
  const lines: string[] = [`(origin ${o ? `(${Math.round(o.x)}, ${Math.round(o.y)})` : '?'}, radius ${scan.radius ?? '?'})`]
  if (scan.entities.length) {
    for (const e of scan.entities.slice(0, 40)) {
      const mining = e.mining ? ` mining ${e.mining}` : ''
      const ore = typeof e.oreUnder === 'number' ? ` ore-left≈${e.oreUnder}` : ''
      lines.push(`  - ${e.name} @(${e.x}, ${e.y}) facing ${e.direction} [${e.status}]${mining}${ore}`)
    }
    if (scan.entities.length > 40) {
      lines.push(`  - … +${scan.entities.length - 40} more entities`)
    }
  }
  else {
    lines.push('  - (no built entities nearby)')
  }
  const res = Object.entries(scan.resources).map(([k, v]) => `${k} x${v.count} near (${v.x}, ${v.y})`)
  lines.push(`  - resources: ${res.join('; ') || '(none nearby)'}`)
  return lines.join('\n')
}

/** Recover the program from the model's Explain/Plan/Code reply. */
export function extractCodeBlock(text: string): string | null {
  // Collect ALL fenced blocks; prefer the LAST one that defines a function (the
  // entry), so an illustrative snippet in the Explain/Plan prose doesn't win.
  const blocks: string[] = []
  const re = /```(?:javascript|typescript|js|ts)?([\s\S]*?)```/gi
  let m: RegExpExecArray | null
  // eslint-disable-next-line no-cond-assign
  while ((m = re.exec(text)) !== null) {
    const body = m[1].trim()
    if (body) {
      blocks.push(body)
    }
  }
  if (blocks.length) {
    const withFn = blocks.filter(b => /async\s+function/.test(b) || /=\s*async\s*\(/.test(b))
    return withFn.length ? withFn[withFn.length - 1] : blocks[blocks.length - 1]
  }
  // No fence: slice from the first async-function declaration so we don't feed prose to the vm.
  const idx = text.search(/async\s+function|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*async\b/)
  if (idx !== -1) {
    return text.slice(idx).trim()
  }
  return null
}

function buildUserMessage(input: GenerateCodeInput): string {
  const lines: string[] = [`OBJECTIVE: ${input.objective}`]
  if (input.context) {
    lines.push(`CONTEXT: ${input.context}`)
  }
  lines.push('', 'CURRENT STATE:', summarizeState(input.state))

  if (input.localMap) {
    lines.push('', 'LOCAL MAP (nearby entities with coords/direction/status + resource patches — use for ops.placeAt):', input.localMap)
  }

  if (input.progress) {
    lines.push('', `PROGRESS SO FAR (already banked — do ONLY the remainder, don't redo finished work): ${input.progress}`)
  }

  if (input.skills && input.skills.length) {
    lines.push(
      '',
      '## Known skills — PREFER calling these over rewriting',
      'These are already-verified skills. Your FIRST move should be to COMPOSE them: `await ops.skill("name")` runs the whole skill (no need to re-implement it). A good new skill is often just a few `ops.skill(...)` calls in order, plus any glue. Only write raw ops for the part no skill covers. Do NOT paste a skill\'s body into your function — call it by name. (The code is shown only so you know what each does / to adapt a small part if truly needed.)',
    )
    for (const s of input.skills) {
      lines.push(`### await ops.skill("${s.name}") — ${s.description}`, '```js', s.code, '```')
    }
  }

  if (input.prevCode) {
    lines.push('', 'YOUR PREVIOUS ATTEMPT FAILED — fix it:', '```js', input.prevCode, '```')
    if (input.lastError) {
      lines.push(`EXECUTION ERROR: ${input.lastError}`)
    }
    if (input.lastCritique) {
      lines.push(`VERIFIER FEEDBACK: ${input.lastCritique}`)
    }
    if (input.hints && input.hints.length) {
      lines.push(`STATIC CHECKS: ${input.hints.join(' ')}`)
    }
  }

  lines.push('', 'Reply with Explain / Plan / Code (a single ```js block defining the entry `async function name(state, ops)`).')
  return lines.join('\n')
}

/** Ask the action LLM for a skill function and extract its source. */
export async function generateCode(input: GenerateCodeInput): Promise<GeneratedCode> {
  const call = input.complete ?? complete
  const raw = (await call({ system: actionPrompt, user: buildUserMessage(input), model: input.model })) ?? ''
  const code = extractCodeBlock(raw)
  // Visibility for debugging the agent's behaviour: log the generated program and
  // whether it follows the mandated workflow (looks recipes up, verifies status).
  // RCON commands are silent now, so this is our only window into what it does.
  if (code) {
    logger.withFields({
      looksUpRecipe: /ops\.getRecipe\b/.test(code),
      describesEntity: /ops\.describeEntity\b/.test(code),
      verifiesScan: /ops\.scan\b/.test(code),
      chars: code.length,
    }).log('Generated skill code')
    // Full source at debug level (set the logger to debug to inspect what the model wrote).
    logger.debug(`GENERATED CODE:\n${code}`)
  }
  return { code, raw }
}

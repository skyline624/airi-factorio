import type { GenerateCodeInput, GeneratedCode, RetrievedSkill } from './action'
import type { VerifyOptions } from './critic'
import type { BatchedCapture } from './state'
import type { GameState, Ops, ScanResult, SuccessCheck, Verdict } from './types'
import { summarizeScan } from './action'
import { lintSkillCode } from './lint'
import { evaluateSuccessCheck, precheckVerdict } from './precheck'
import { runSkill } from './runtime'
import { diffState } from './state'

export interface AttemptDeps {
  /** Fresh ops per attempt (fresh op budget; shares the session settle bus). */
  makeOps: () => Ops
  /** Snapshot the world (outside the skill, so it does not consume the op budget). */
  captureState: () => Promise<GameState>
  /** Clear the mod's task queue before each attempt, killing any orphaned task from a timed-out attempt. */
  resetTasks?: () => Promise<void>
  /** Optional spatial scan → a local map shown to the action LLM (before) and the critic (after). */
  captureScan?: () => Promise<ScanResult>
  /** Optional force-wide production counters → the critic sees what was actually MADE during the objective (not just what the player holds). */
  captureProduction?: () => Promise<Record<string, number> | null>
  /** Optional ONE-round-trip post-run capture (state + factory census + production). When set, used instead of the three separate calls. */
  captureBatch?: () => Promise<BatchedCapture>
  generateCode: (input: GenerateCodeInput) => Promise<GeneratedCode>
  verify: (options: VerifyOptions) => Promise<Verdict>
  actionModel: string
  /** Optional faster model for the first attempts; empty = always use actionModel. */
  fastActionModel?: string
  /** Attempts 1..N use fastActionModel; later attempts escalate to actionModel. Default 2. */
  modelEscalateAfter?: number
  criticModel: string
  sandboxTimeoutMs: number
  maxRetries?: number
  skills?: RetrievedSkill[]
  /** When false, skip the deterministic pre-critic and always ask the LLM critic. Default: enabled. */
  deterministicCritic?: boolean
  log?: (message: string) => void
}

export interface AttemptResult {
  success: boolean
  code: string | null
  raw?: string
  attempts: number
  logs: string[]
  verdict?: Verdict
}

/**
 * "iron-plate +32, iron-gear-wheel +5" — what the force PRODUCED between the two
 * counter snapshots. Undefined when production capture is unavailable; '(nothing
 * produced)' when counters did not move (a strong signal for the critic).
 */
export function summarizeProductionDelta(before: Record<string, number> | null, after: Record<string, number> | null): string | undefined {
  if (!before || !after) {
    return undefined
  }
  const parts: string[] = []
  for (const [item, count] of Object.entries(after)) {
    const delta = count - (before[item] ?? 0)
    if (delta > 0) {
      parts.push(`${item} +${delta}`)
    }
  }
  return parts.length ? parts.join(', ') : '(nothing produced)'
}

/**
 * Voyager-style iterative prompting for ONE objective: generate code → run it in
 * the sandbox → verify via the critic → on failure, re-prompt with the previous
 * code + execution error + critique. Returns once verified or the retry budget
 * is spent. `before` is captured once so the critic judges cumulative progress.
 */
export async function attemptObjective(objective: string, context: string, deps: AttemptDeps, successCheck?: SuccessCheck): Promise<AttemptResult> {
  const maxRetries = deps.maxRetries ?? 4
  // `before` (objective start) is fixed so the critic judges CUMULATIVE progress;
  // `current` is refreshed each retry so the action LLM sees the latest world.
  const before = await deps.captureState()
  if (!before.position && Object.keys(before.inventory).length === 0) {
    deps.log?.('WARNING: captured state is empty (no position, no inventory). Is player 1 the agent and spawned? The critic will fail every attempt against a blank state.')
  }
  let current = before
  // Production counters at objective start — the critic judges what was MADE since.
  const prodBefore = deps.captureProduction ? await deps.captureProduction() : null

  let prevCode: string | null = null
  let lastError: string | null = null
  let lastCritique: string | null = null
  let lastLogs: string[] | null = null
  let lastHints: string[] | null = null
  // The post-run machine status (entities + status) the critic just judged. Reused as the
  // next attempt's local map so the model sees EXACTLY the critic's evidence (and we skip a scan).
  let lastScanSummary: string | undefined
  let lastVerdict: Verdict | undefined
  let logs: string[] = []
  let code: string | null = null
  let raw = ''

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Model routing: cheap/fast model for the first attempts, escalate to the capable model
    // once they've been spent. Disabled (always actionModel) when no fast model is configured.
    const actionModel = (deps.fastActionModel && attempt <= (deps.modelEscalateAfter ?? 2))
      ? deps.fastActionModel
      : deps.actionModel
    deps.log?.(`Attempt ${attempt}/${maxRetries} [${actionModel}]: ${objective}`)

    // Clear any orphaned task from a previous (e.g. timed-out) attempt so its late
    // completion can't resolve this attempt's first op.
    await deps.resetTasks?.()

    // On a retry, reuse the previous run's post-run scan (nothing changed but cancelled
    // orphan tasks) — it is precisely what the critic judged, and saves a fresh scan.
    const localMap = (attempt > 1 && lastScanSummary !== undefined)
      ? lastScanSummary
      : (deps.captureScan ? summarizeScan(await deps.captureScan()) : null)

    const gen = await deps.generateCode({
      objective,
      context,
      state: current,
      skills: deps.skills,
      prevCode,
      lastError,
      lastCritique,
      lastLogs,
      hints: lastHints,
      progress: attempt === 1 ? null : diffState(before, current),
      localMap,
      model: actionModel,
    })
    code = gen.code
    raw = gen.raw

    if (!code) {
      lastError = 'No runnable async function could be extracted. Return a ```js block defining `async function name(state, ops)`.'
      deps.log?.('  -> no code extracted; retrying')
      continue
    }

    // Cheap static pass before the expensive sandbox run: a sandbox-forbidden global is a
    // definite defect — re-prompt immediately instead of wasting a run. Soft hints (blind
    // placement, missing await) are only surfaced if this attempt then fails.
    const lint = lintSkillCode(code)
    if (lint.hardError) {
      prevCode = code
      lastError = lint.hardError
      lastCritique = null
      lastLogs = null
      lastHints = null
      deps.log?.(`  -> static check rejected the code (no run): ${lint.hardError}`)
      continue
    }

    const ops = deps.makeOps()
    const result = await runSkill(code, ops, current, { timeoutMs: deps.sandboxTimeoutMs })
    logs = result.logs
    // Surface the skill's RUNTIME error (e.g. a primitive that returned !ok and threw — the
    // deterministic dispatcher throws "bootstrap: could not fuel..." / "automateResource: ...").
    // Without this the throw is swallowed by the sandbox and the only visible signal is the
    // successCheck FAIL ("hold 0"), which says WHAT didn't happen but not WHY. Also surface the
    // skill's own ops.log trace (the bootstrap logs furnace fuel/input/output, automateResource's
    // production poll, etc.) so the exact failing step is visible — on a run error AND (see below)
    // on a successCheck FAIL, since a timed-out poll returns ok:true but its trace shows WHY the
    // check failed (e.g. "poll N coal produced=0").
    if (!result.ok) {
      if (result.error) {
        deps.log?.(`  -> run error: ${result.error}`)
      }
      if (logs.length) {
        deps.log?.(`  -> skill logs: ${logs.join(' | ')}`)
      }
    }

    // Post-run evidence. Prefer the batched one-round-trip capture; fall back to the
    // three separate calls when no batch capture is wired (e.g. in unit tests).
    let after: GameState
    let scanSummary: string | undefined
    let scanAfter: ScanResult | undefined
    let prodAfter: Record<string, number> | null
    if (deps.captureBatch) {
      const batch = await deps.captureBatch()
      after = batch.state
      scanAfter = batch.scan
      scanSummary = summarizeScan(batch.scan)
      prodAfter = batch.production
    }
    else {
      after = await deps.captureState()
      scanAfter = deps.captureScan ? await deps.captureScan() : undefined
      scanSummary = scanAfter ? summarizeScan(scanAfter) : undefined
      prodAfter = deps.captureProduction ? await deps.captureProduction() : null
    }
    const productionSummary = summarizeProductionDelta(prodBefore, prodAfter)

    // Verdict, cheapest-first: (1) the curriculum's EXPLICIT machine-checkable criterion —
    // fully deterministic, no LLM; (2) else the heuristic precheck (mine/build/research by
    // text); (3) only objectives with NEITHER a check NOR a precheck decision (e.g. a reactive
    // chat command, or a malformed check) reach the LLM critic. So a curriculum objective never
    // pays a critic-LLM round-trip.
    const pre = deps.deterministicCritic === false
      ? { decided: false as const }
      : (successCheck
          ? evaluateSuccessCheck(successCheck, { objective, before, after, prodBefore, prodAfter, scanAfter })
          : precheckVerdict({ objective, before, after, prodBefore, prodAfter, scanAfter }))
    const verdict: Verdict = pre.decided
      ? { success: pre.success ?? false, critique: pre.critique ?? '', reasoning: pre.reasoning }
      : await deps.verify({ objective, before, after, logs, scanSummary, productionSummary, model: deps.criticModel })
    if (pre.decided) {
      deps.log?.(`  -> ${successCheck ? 'successCheck' : 'precheck'} ${verdict.success ? 'PASS' : 'FAIL'} (deterministic, no critic LLM): ${pre.reasoning ?? ''}`)
    }
    lastVerdict = verdict

    if (verdict.success) {
      deps.log?.(`  -> verified success in ${attempt} attempt(s)`)
      return { success: true, code, raw, attempts: attempt, logs, verdict }
    }
    // The run succeeded (ok:true) but the successCheck FAILed — e.g. a production poll that timed
    // out. Surface the skill's ops.log trace (the poll values) so WHY the check failed is visible,
    // not just THAT it failed.
    if (result.ok && logs.length) {
      deps.log?.(`  -> skill logs: ${logs.join(' | ')}`)
    }

    current = after
    prevCode = code
    lastError = result.ok ? null : (result.error ?? null)
    lastCritique = verdict.critique
    // Feed the skill's own log output (the game's exact per-op errors + the agent's ops.log
    // diagnostics) back to the next attempt — so it fixes the named cause instead of repeating
    // blind (the missing-ingredient, smelt-timing, out-of-reach, no-fuel walls all surface here).
    lastLogs = logs.length ? logs : null
    // Surface the static smells (blind placement / missing await) to the next attempt.
    lastHints = lint.hints.length ? lint.hints : null
    // Feed this run's post-run machine status forward as the next attempt's local map.
    lastScanSummary = scanSummary
    deps.log?.(`  -> not yet: ${verdict.critique || result.error || 'unknown'}`)
  }

  return { success: false, code, raw, attempts: maxRetries, logs, verdict: lastVerdict }
}

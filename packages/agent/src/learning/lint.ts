/**
 * A cheap STATIC pass over the model's generated skill, run before the 120 s
 * sandbox execution. Two outputs:
 *
 *  - `hardError`: a definite, zero-false-positive defect (a sandbox-forbidden
 *    global the code WILL fail on). When set, the caller skips execution and
 *    re-prompts with this message — saving a wasted run and giving the model a
 *    crisper reason than the raw runtime/compile error.
 *  - `hints`: high-precision smells that don't error but produce bad results
 *    (placing blind, never awaiting). These are surfaced into the NEXT retry's
 *    feedback only if the attempt fails — never a bounce, so a stray hint can't
 *    waste an otherwise-good attempt.
 *
 * Deliberately conservative: better to miss a defect than to wrongly reject
 * valid code. The sandbox + critic remain the real safety net.
 */
export interface LintResult {
  hardError?: string
  hints: string[]
}

// Sandbox-forbidden globals: the vm context exposes ONLY `ops`, `state`, `console`
// and realm intrinsics — these are guaranteed to be undefined.
const FORBIDDEN: Array<{ re: RegExp, what: string }> = [
  { re: /\brequire\s*\(/, what: 'require()' },
  { re: /(^|[\n;{}])\s*import[\s{*'"]/, what: 'ES `import`' },
  { re: /\bimport\s*\(/, what: 'dynamic import()' },
  { re: /\bprocess\s*\./, what: 'process' },
  { re: /\bfetch\s*\(/, what: 'fetch()' },
  { re: /\bset(?:Timeout|Interval)\s*\(/, what: 'timers (setTimeout/setInterval)' },
]

// The async ops a skill must await (perception + actions). Used to spot "calls ops
// but never awaits". setRecipe/getRecipe/etc. are all async too — any ops.* call is.
const OPS_CALL = /\bops\.\w+\s*\(/
const MAP_READ = /\bops\.(?:renderMap|scan|getState)\s*\(/
const PLACE = /\bops\.placeAt\s*\(/

export function lintSkillCode(code: string): LintResult {
  for (const { re, what } of FORBIDDEN) {
    if (re.test(code)) {
      return {
        hardError: `sandbox: ${what} is unavailable. Your ONLY capabilities are the \`ops\` API and standard JS — no network, files, modules, or timers. Use \`await ops.wait(ticks)\` for in-game delays.`,
        hints: [],
      }
    }
  }

  const hints: string[] = []
  if (OPS_CALL.test(code) && !/\bawait\b/.test(code)) {
    hints.push('Your previous code called `ops.*` but never used `await` — every ops call is async. Prefix each with `await` and check `.ok`.')
  }
  if (PLACE.test(code) && !MAP_READ.test(code)) {
    hints.push('Your previous code called `ops.placeAt` without first reading the world (`renderMap`/`scan`/`getState`) — take coordinates from DATA, not a guess. Read the map before placing.')
  }
  return { hints }
}

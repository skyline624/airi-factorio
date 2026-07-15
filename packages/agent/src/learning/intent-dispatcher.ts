/**
 * Maps a deterministic roadmap `Intention` to a `GeneratedCode` that calls ONE composite primitive
 * — without an LLM. The produced function is fed to the SAME sandbox + lint + deterministic critic
 * pipeline as LLM-generated skills (`attemptObjective`), so the engine reuses all of that: the
 * only thing replaced is the "where does the code come from" step.
 *
 * The code THROWS when the primitive returns `{ ok: false }`. A built-but-not-running machine
 * (e.g. a steam-engine with `no_water`) would otherwise PASS a `build` successCheck (the entity
 * exists); throwing makes the run fail loudly, the successCheck then runs against an unchanged
 * state and FAILs, and the engine can diagnose / yield to the LLM. `automateResource` is also
 * idempotent and self-repairs (re-fuels, re-places a missing output), so a retry after a transient
 * `no_fuel` is cheap and deterministic.
 *
 * The output passes `lintSkillCode` by construction: it calls a single `ops.<verb>(...)` with
 * JSON-serialised args (no literal coordinates, no forbidden globals).
 */
import type { GeneratedCode } from './action'
import type { Intention } from './roadmap'

export function dispatchIntent(intention: Intention): GeneratedCode {
  const verb = intention.verb
  const args = intention.args.map(a => JSON.stringify(a)).join(', ')
  const name = `r_${verb.replace(/\W/g, '_')}`
  const code
    = `async function ${name}(state, ops){ `
      + `const res = await ops.${verb}(${args}); `
      + `if (res && !res.ok) throw new Error((res && res.error) || '${verb} failed') `
      + `}`
  return { code, raw: code }
}

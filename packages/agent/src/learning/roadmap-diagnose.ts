/**
 * Deterministic post-failure diagnosis for the roadmap rungs. When a rung's `successCheck` FAILs,
 * the engine asks this whether a RETRY is worthwhile (the primitive can self-repair) or whether
 * the cause is structural and the engine must yield to the LLM (open mode).
 *
 * The repair itself is delegated to the primitive's IDEMPOTENCE, NOT done here with raw ops:
 * `automateResource` re-fuels a `no_fuel` drill and re-places a missing furnace; `buildSteamPower`
 * re-places a missing engine. So "retry" just means "run the same primitive again" — no LLM, no
 * bespoke repair code. The diagnosis only DECIDES retry-vs-open from the post-run factory census
 * (the scan), to (a) not loop forever on a transient stall and (b) not STACK machines on a
 * structural failure (e.g. don't place a second steam-engine chain next to a `no_water` one).
 */
import type { Rung } from './roadmap'
import type { ScanResult } from './types'

export interface DiagnoseResult {
  /** true = re-run the same rung's primitive (it can self-repair); false = yield to the LLM. */
  retry: boolean
  /** short reason, logged and (on yield) fed to the open-mode curriculum. */
  reason?: string
}

function hasEntity(scan: ScanResult, name: string): boolean {
  return scan.entities.some(e => e.name === name)
}

export function diagnoseRung(rung: Rung, scan: ScanResult): DiagnoseResult {
  switch (rung.intention.verb) {
    case 'bootstrap': {
      // bootstrap is NOT idempotent: the first attempt consumes coal/ore/stone and PLACES a
      // furnace, so a retry restarts from a partially-consumed state (less coal, a 2nd furnace)
      // and under-yields / collides. It's deterministic — a failure is a real wall (under-yield, no
      // buildable tile), not a transient stall. Yield to the LLM instead of looping the rung.
      return { retry: false, reason: `bootstrap failed — yield to LLM (not idempotent: retry would consume more / place a 2nd furnace)` }
    }
    case 'automateResource': {
      // automateResource is idempotent + self-repairing (re-fuel, re-place a missing output), so a
      // retry is worthwhile whether the drill is missing, on the wrong ore, or just `no_fuel`.
      const resource = rung.intention.args[0] as string
      const drills = scan.entities.filter(e => e.type === 'mining-drill')
      const onResource = drills.filter(e => e.mining === resource)
      if (onResource.length === 0) {
        return { retry: true, reason: `no drill on '${resource}' yet — automateResource will place + output + fuel` }
      }
      const stalled = onResource.some(d => d.status === 'no_fuel')
      return {
        retry: true,
        reason: stalled
          ? `drill on '${resource}' is no_fuel — automateResource refuels it (idempotent)`
          : `produce failed despite a drill on '${resource}' — automateResource re-checks/re-places the output (idempotent)`,
      }
    }
    case 'buildSteamPower': {
      // Retry only if no engine exists yet. If an engine is already present but not 'working'
      // (no_water / no pole / no fuel), DON'T stack a second chain — yield to the LLM.
      if (!hasEntity(scan, 'steam-engine')) {
        return { retry: true, reason: 'no steam-engine yet — buildSteamPower will place the pump→boiler→engine chain' }
      }
      const eng = scan.entities.find(e => e.name === 'steam-engine')
      return { retry: false, reason: `steam-engine present but not working (status: ${eng?.status ?? 'unknown'}) — yield to LLM (water/pole/coal?)` }
    }
    case 'connectPowerTo': {
      // Prereq: a steam-engine exists (the 'steam' rung is done before this). Retry lays the pole.
      if (hasEntity(scan, 'steam-engine')) {
        return { retry: true, reason: 'steam-engine present — connectPowerTo will lay the pole line' }
      }
      return { retry: false, reason: 'no steam-engine to connect power from — yield to LLM (steam rung prerequisite?)' }
    }
    case 'buildChain': {
      // buildChain needs electricity. Retry only if a pole exists (the power network is up).
      if (hasEntity(scan, 'small-electric-pole')) {
        return { retry: true, reason: 'power network up — buildChain will place the assembler + belts + inserters' }
      }
      return { retry: false, reason: 'no power network (no small-electric-pole) — buildChain needs electricity; yield to LLM (steam/pole rung?)' }
    }
    default:
      return { retry: true, reason: `'${rung.id}' failed — retry the primitive` }
  }
}

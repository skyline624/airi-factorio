/**
 * Deterministic roadmap of the KNOWN automation rungs toward steam power + intermediates.
 *
 * The Voyager-style LLM curriculum + action-as-code is expensive (~5 LLM calls/rung) and, on
 * weak models, loops — it never proposes `automateResource` and hand-mines instead. But the rungs
 * toward steam are a FIXED sequence of existing composite primitives (`automateResource`,
 * `buildSteamPower`, `connectPowerTo`, `buildChain`). So the engine runs them with ZERO LLM: it
 * walks this list in order, calls each primitive directly (via the intent dispatcher), and proves
 * each rung with the deterministic critic (`evaluateSuccessCheck`). The LLM (compact curriculum +
 * action-as-code) only takes over for rungs WITHOUT a primitive (lab+science, oil, rocket-silo)
 * and for unrecoverable failures — see `session.ts` mode `roadmap` → `open`.
 *
 * A rung is `done` once its `successCheck` has PASSed at least once; it never replays. If the
 * first not-done rung's precondition is not ready (a resource isn't reachable), the engine
 * yields to the LLM (open mode) to fix the prerequisite — e.g. walk to an iron patch.
 */
import type { GameState, SuccessCheck } from './types'

/** A high-level action the engine maps 1:1 to a primitive call. `args` are JSON-serialisable. */
export interface Intention {
  /** the `ops.<verb>` composite primitive to call, e.g. 'automateResource' / 'buildSteamPower'. */
  verb: string
  /** positional args for the primitive, e.g. ['iron-ore'] or ['iron-gear-wheel', ['iron-plate']]. */
  args: unknown[]
}

/** Context handed to a rung's `precondition`. */
export interface PrecondCtx {
  state: GameState
  /** nearby resource patches (from `scan_area`): name → { count, x, y }. `x`/`y` are the patch centre. */
  resources: Record<string, { count: number, x: number, y: number }>
}

export interface PrecondResult {
  ready: boolean
  /** why not ready (logged, and fed to the open-mode curriculum if we yield). */
  reason?: string
}

/** One step on the deterministic path to steam + intermediates. */
export interface Rung {
  id: string
  /** human-readable, logged as the objective ("Automate iron (drill + furnace, both working)"). */
  objective: string
  /** short hint passed to attemptObjective as `context`. */
  context: string
  intention: Intention
  /** the deterministic machine-verifiable criterion consumed by `evaluateSuccessCheck`. */
  successCheck: SuccessCheck
  /** if present and not ready, the engine yields to the LLM instead of running this rung. */
  precondition?: (ctx: PrecondCtx) => PrecondResult
}

/** A resource patch is reachable (exists within the resource scan). */
function resourceReady(name: string, ctx: PrecondCtx): PrecondResult {
  const r = ctx.resources[name]
  return r ? { ready: true } : { ready: false, reason: `no '${name}' patch within scan range — explore/walk to one first` }
}

/**
 * The ordered rungs. Order matters: each rung's prerequisites are the rungs before it (the engine
 * only advances once the previous `successCheck` PASSed), so later rungs need no explicit
 * precondition beyond resource reachability where it matters.
 *
 *   1 iron    automateResource('iron-ore')   → produce iron-plate   (smelts via a furnace)
 *   2 coal    automateResource('coal')        → produce coal        (drill + chest; fuels everything)
 *   3 copper  automateResource('copper-ore')  → produce copper-plate
 *   4 steam   buildSteamPower()               → status steam-engine 'working'
 *   5 pole    connectPowerTo('steam-engine')   → build small-electric-pole (wires the engine to a network)
 *   6 gears   buildChain('iron-gear-wheel', ['iron-plate'])           → produce iron-gear-wheel (electric assembler)
 *   7 circuits buildChain('electronic-circuit', ['iron-plate','copper-plate']) → produce electronic-circuit
 */
export const ROADMAP: Rung[] = [
  {
    id: 'bootstrap',
    objective: 'Hand-bootstrap the factory from an empty inventory: mine iron-ore + stone + coal, smelt 5 iron-plate, craft a burner-mining-drill + a spare stone-furnace, so the automation primitives can then take over.',
    context: 'Deterministic rung — call ops.bootstrap(); it mines, smelts and crafts the minimum to start automating. No precondition: it starts from scratch (an empty inventory).',
    intention: { verb: 'bootstrap', args: [] },
    // The drill being CRAFTED (held) proves the bootstrap chain is complete (plates smelted +
    // gears crafted + furnace crafted) — the thing automateResource can't do (iron-plate smelts,
    // it isn't crafted, so craftAll('iron-plate') fails).
    successCheck: { kind: 'acquire', item: 'burner-mining-drill', count: 1 },
  },
  {
    id: 'iron',
    objective: 'Automate iron: a burner-mining-drill on the nearest iron-ore patch with a stone-furnace on its output, both fueled and working, producing iron-plate.',
    context: 'Deterministic rung — call ops.automateResource("iron-ore"); it places the drill + furnace + fuel and is idempotent (repairs a stalled line).',
    intention: { verb: 'automateResource', args: ['iron-ore'] },
    successCheck: { kind: 'produce', item: 'iron-plate', count: 3 },
    precondition: ctx => resourceReady('iron-ore', ctx),
  },
  {
    id: 'coal',
    objective: 'Automate coal: a burner-mining-drill on the nearest coal patch with a chest on its output, fueled and working, producing coal (the fuel of every burner machine).',
    context: 'Deterministic rung — call ops.automateResource("coal"); coal does not smelt, so the primitive places a chest on the drill output.',
    intention: { verb: 'automateResource', args: ['coal'] },
    successCheck: { kind: 'produce', item: 'coal', count: 3 },
    precondition: ctx => resourceReady('coal', ctx),
  },
  {
    id: 'copper',
    objective: 'Automate copper: a burner-mining-drill on the nearest copper-ore patch with a stone-furnace on its output, both fueled and working, producing copper-plate.',
    context: 'Deterministic rung — call ops.automateResource("copper-ore").',
    intention: { verb: 'automateResource', args: ['copper-ore'] },
    successCheck: { kind: 'produce', item: 'copper-plate', count: 3 },
    precondition: ctx => resourceReady('copper-ore', ctx),
  },
  {
    id: 'steam',
    objective: 'Build steam power: an offshore-pump → boiler → steam-engine chain, fluid-connected and fueled, with the steam-engine actually working (producing steam).',
    context: 'Deterministic rung — call ops.buildSteamPower(); it walks to water, places + fluid-connects the pump→boiler→engine and fuels the boiler.',
    intention: { verb: 'buildSteamPower', args: [] },
    // 'status working' (not just 'build') so a built-but-no_water engine is caught — the build
    // check alone would PASS on an engine that isn't producing.
    successCheck: { kind: 'status', entity: 'steam-engine', want: 'working', count: 1 },
  },
  {
    id: 'pole',
    objective: 'Wire the steam-engine to a power network: lay an electric pole next to it so the network is live.',
    context: 'Deterministic rung — call ops.connectPowerTo("steam-engine"); it ensures + places a small-electric-pole by the engine.',
    intention: { verb: 'connectPowerTo', args: ['steam-engine'] },
    successCheck: { kind: 'build', entity: 'small-electric-pole', count: 1 },
  },
  {
    id: 'gears',
    objective: 'Automate iron-gear-wheel: an assembling-machine-1 with the iron-gear-wheel recipe, fed iron-plate, powered, producing iron-gear-wheel.',
    context: 'Deterministic rung — call ops.buildChain("iron-gear-wheel", ["iron-plate"]); it places the assembler + belts + inserters + power for the recipe.',
    intention: { verb: 'buildChain', args: ['iron-gear-wheel', ['iron-plate']] },
    successCheck: { kind: 'produce', item: 'iron-gear-wheel', count: 3 },
  },
  {
    id: 'circuits',
    objective: 'Automate electronic-circuit: an assembling-machine-1 with the electronic-circuit recipe, fed iron-plate + copper-plate, powered, producing electronic-circuit.',
    context: 'Deterministic rung — call ops.buildChain("electronic-circuit", ["iron-plate", "copper-plate"]).',
    intention: { verb: 'buildChain', args: ['electronic-circuit', ['iron-plate', 'copper-plate']] },
    successCheck: { kind: 'produce', item: 'electronic-circuit', count: 3 },
  },
]

/**
 * Pick the next rung to execute. Returns the first NOT-done rung whose precondition is ready.
 * If the first not-done rung's precondition is NOT ready, returns null (yield to the LLM: it must
 * fix the prerequisite — e.g. walk to an iron patch — before the roadmap can resume). If every
 * rung is done, returns null (the roadmap is exhausted → open mode for the rungs beyond steam).
 *
 * `done` is the set of rung ids whose `successCheck` has PASSed at least once this session.
 */
export function selectRung(roadmap: Rung[], done: ReadonlySet<string>, ctx: PrecondCtx): { rung: Rung, blocked: false } | { rung: null, blocked: true, reason: string } {
  for (const rung of roadmap) {
    if (done.has(rung.id)) {
      continue
    }
    // First not-done rung.
    if (!rung.precondition) {
      return { rung, blocked: false }
    }
    const p = rung.precondition(ctx)
    if (p.ready) {
      return { rung, blocked: false }
    }
    // The prerequisite for the next rung isn't met — the engine can't fix "no iron patch nearby"
    // deterministically; yield to the LLM (open) to walk/explore, then the roadmap can resume.
    return { rung: null, blocked: true, reason: `rung '${rung.id}' blocked: ${p.reason ?? 'precondition not ready'}` }
  }
  // All rungs done.
  return { rung: null, blocked: true, reason: 'roadmap exhausted (all known rungs complete)' }
}

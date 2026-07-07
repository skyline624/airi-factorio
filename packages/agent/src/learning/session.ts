import type { GameState, ScanResult, SuccessCheck } from './types'
import { useLogg } from '@guiiai/logg'
import { generateCode, summarizeScan } from './action'
import { attemptObjective } from './attempt'
import { verify } from './critic'
import { proposeNextObjective } from './curriculum'
import { extractLastJsonLine } from './json'
import { createGameDataCache, createOps, extractEntryName, runSkill, syncCacheEpoch } from './runtime'
import { createSettleBus } from './settle-bus'
import { createSkillLibrary } from './skill-library'
import { captureState as captureStateFn, parseScan } from './state'

const logger = useLogg('learning').useGlobalConfig()

export interface LearningSessionDeps {
  /** Send a full `/c ...` console command and resolve with the rcon output. */
  raw: (input: string) => Promise<string>
  /** Say a line in the in-game chat. */
  say: (message: string) => Promise<void>
  /**
   * In-game player name the agent controls. Empty = auto-detect first
   * connected player. Bound into the captureState closure.
   */
  playerName?: string
  /** Reactive mode: no curriculum or fixed list — WAIT for chat commands and run each as an objective through the same action-as-code pipeline (renderMap/placeAt/skills/critic). */
  reactive?: boolean
  /** When true, the curriculum proposes objectives; otherwise the fixed `objectives` list is used. */
  curriculumEnabled: boolean
  /** The end goal the curriculum works toward. */
  ultimateGoal: string
  /** Max objectives to run in this session (bounds an autonomous run). */
  maxObjectives: number
  /** Fixed objectives (used when curriculumEnabled is false). */
  objectives: string[]
  actionModel: string
  /** Optional faster model for the first attempts; empty = always actionModel. */
  fastActionModel?: string
  /** Attempts 1..N use fastActionModel; later attempts escalate. */
  modelEscalateAfter?: number
  criticModel: string
  embeddingModel: string
  embeddingBaseUrl: string
  skillsDir: string
  sandboxTimeoutMs: number
  settleTimeoutMs: number
  maxOpsPerSkill: number
  maxRetries: number
  /** When true (default), the deterministic pre-critic settles mechanical objectives without an LLM call. */
  deterministicCritic?: boolean
  /** When false, disable the per-session static-knowledge cache (recipe/entity/craft-plan). Default: enabled. */
  gameDataCache?: boolean
}

export interface LearningController {
  /** Fed by the WS reader when the mod prints a per-op result. */
  onSettled: (result: 'completed' | 'error', detail?: string) => void
  /** Fed when the mod prints a structured [RESULT] line; stashed for the next settle. */
  onResult: (data: Record<string, unknown>) => void
  /** Fed when a human types in chat — becomes the next objective (a redirection). */
  onChat: (username: string, message: string) => void
  /** Fed when a perception [EVENT] arrives. */
  onPerception: (text: string) => void
  stop: () => void
}

/**
 * Full lifelong loop (steps 3+4+5): the curriculum proposes the next objective
 * toward the rocket, the action -> run -> verify loop attempts it (reusing and
 * composing learned skills), and verified successes are stored back. A human chat
 * line redirects the next objective. Bounded by maxObjectives.
 */
export function startLearningSession(deps: LearningSessionDeps): LearningController {
  const settleBus = createSettleBus(deps.settleTimeoutMs)
  // Per-session cache of static knowledge lookups (recipe/entity/craft-plan), shared by
  // every skill's ops. Research-dependent entries are dropped when researchedCount rises.
  const gameDataCache = deps.gameDataCache === false ? undefined : createGameDataCache()
  const captureState = async (): Promise<GameState> => {
    const s = await captureStateFn(deps.raw, deps.playerName ?? '')
    if (gameDataCache && typeof s.researchedCount === 'number') {
      syncCacheEpoch(gameDataCache, s.researchedCount)
    }
    return s
  }
  // The critic's post-run evidence: a surface-wide census of the force's producing
  // machines + status (NOT a player-centred scan, which misses the build whenever
  // the agent wandered off — e.g. to mine coal — before the run ended).
  const captureScan = async (): Promise<ScanResult> => parseScan(await deps.raw('/c remote.call(\'autorio_tools\', \'scan_factory\')'))
  // Player-centred resource scan: the ore patches (and how far) actually within reach.
  // The curriculum needs this to know what is REACHABLE — otherwise it can't tell the
  // agent is already standing on iron and keeps proposing "go find iron" forever.
  const captureResources = async (): Promise<ScanResult> => parseScan(await deps.raw('/c remote.call(\'autorio_tools\', \'scan_area\', 64)'))
  // ASCII map centred on the player, given to the CURRICULUM so the planner sees spatial
  // reality (a general reads the map) — it can then catch a broken drill->furnace feed (an
  // uncovered `X`), overlaps, free space, etc., instead of mis-reading text status.
  const captureMap = async (center?: { x: number, y: number }): Promise<string | undefined> => {
    if (!center) {
      return undefined
    }
    const d = extractLastJsonLine<{ grid?: string[], legend?: string }>(await deps.raw(`/c remote.call('autorio_tools','render_map',${Math.floor(center.x)},${Math.floor(center.y)},18)`))
    return (d && Array.isArray(d.grid)) ? `${d.legend ?? ''}\n${d.grid.join('\n')}` : undefined
  }
  // Force-wide production counters: what was MADE (hand or machine). The critic gets
  // the per-objective delta; the curriculum gets the totals (is anything automated yet?).
  const captureProduction = async (): Promise<Record<string, number> | null> => {
    const d = extractLastJsonLine<{ produced?: Record<string, number> }>(await deps.raw('/c remote.call(\'autorio_tools\', \'production_stats\')'))
    return (d && typeof d === 'object' && d.produced) ? d.produced : null
  }

  const library = createSkillLibrary({
    dir: deps.skillsDir,
    embeddingModel: deps.embeddingModel,
    embeddingBaseUrl: deps.embeddingBaseUrl,
    descriptionModel: deps.criticModel,
  })

  const makeOps = () => createOps({
    raw: deps.raw,
    settleBus,
    maxOps: deps.maxOpsPerSkill,
    cache: gameDataCache,
    runSkillByName: async (name, _args, ops) => {
      const skill = library.get(name)
      if (!skill) {
        return { ok: false, error: `unknown skill: ${name}` }
      }
      const state = await captureState()
      const result = await runSkill(skill.code, ops, state, { timeoutMs: deps.sandboxTimeoutMs })
      return { ok: result.ok, error: result.error }
    },
  })

  const resetTasks = async (): Promise<void> => {
    await deps.raw('/c remote.call(\'autorio_operations\', \'cancel_all_tasks\')').catch(() => {})
  }

  let running = true
  let pendingRedirect: string | null = null
  let reactiveWaiter: (() => void) | null = null
  const completed: string[] = []
  // Failed objectives WITH their critique (why they failed) so the curriculum can fix the
  // cause / pick a different prerequisite instead of blindly re-proposing the same string.
  const failedDetails: { objective: string, critique: string }[] = []
  // Consecutive-repeat guard: how many times in a row the SAME objective was proposed after
  // failing. Once it repeats, we hard-forbid it in the next curriculum prompt to break loops.
  let lastFailedObjective: string | null = null
  let repeatCount = 0

  /** Normalised objective for repeat comparison (trim + lowercase + collapse whitespace). */
  const normObjective = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ')

  async function runOneObjective(objective: string, context: string, successCheck?: SuccessCheck): Promise<boolean> {
    await deps.say(`New objective: ${objective}`).catch(() => {})

    const skills = await library.retrieve(`${objective} ${context}`.trim())
    if (skills.length) {
      logger.withFields({ skills: skills.map(s => s.name) }).log('Retrieved relevant learned skills')
    }

    const result = await attemptObjective(objective, context, {
      makeOps,
      captureState,
      captureScan,
      captureProduction,
      // captureBatch deliberately omitted: its jcall() does remote.call(...) which returns
      // the handler's Lua return value (true), NOT the rcon.print JSON — so batch.production
      // and batch.scan came back null/boolean, making the deterministic critic always see a
      // +0 production delta (false FAIL on every 'produce' check). Falling back to the three
      // separate calls below costs one extra round-trip but actually measures production.
      resetTasks,
      generateCode,
      verify,
      skills,
      actionModel: deps.actionModel,
      fastActionModel: deps.fastActionModel,
      modelEscalateAfter: deps.modelEscalateAfter,
      criticModel: deps.criticModel,
      sandboxTimeoutMs: deps.sandboxTimeoutMs,
      maxRetries: deps.maxRetries,
      deterministicCritic: deps.deterministicCritic,
      log: message => logger.log(message),
    }, successCheck)

    if (result.success && result.code) {
      const name = extractEntryName(result.code)
      const stored = name ? await library.add({ name, code: result.code, objective }) : null
      completed.push(objective)
      lastFailedObjective = null
      repeatCount = 0
      logger.withFields({ attempts: result.attempts, skill: stored?.name, description: stored?.description }).log('✅ Objective achieved and skill stored')
      await deps.say(`Done: ${objective}`).catch(() => {})
      return true
    }
    const critique = result.verdict?.critique ?? 'no critique'
    failedDetails.push({ objective, critique })
    // Track consecutive repeats of the SAME failed objective so the curriculum loop can
    // hard-forbid it next time instead of re-proposing it forever.
    if (lastFailedObjective !== null && normObjective(lastFailedObjective) === normObjective(objective)) {
      repeatCount += 1
    }
    else {
      repeatCount = 1
    }
    lastFailedObjective = objective
    logger.withFields({ attempts: result.attempts, critique, repeatCount }).warn('❌ Objective not achieved within the retry budget')
    await deps.say(`I could not finish: ${objective}`).catch(() => {})
    return false
  }

  async function loop() {
    logger.withFields({ reactive: deps.reactive ?? false, curriculum: deps.curriculumEnabled, ultimateGoal: deps.ultimateGoal, maxObjectives: deps.maxObjectives, knownSkills: library.size() }).log('Action-as-code session started')

    // Reactive mode: the human chat is the sole source of objectives. Wait for a command,
    // run it through the SAME action pipeline (renderMap/placeAt/skills/critic), then wait
    // again. Same engine as learning — only the objective source differs.
    if (deps.reactive) {
      logger.log('Reactive mode: waiting for chat commands (type a task in-game)…')
      // A direct human command must be executed LITERALLY and minimally — not turned into a
      // full autonomous build. Passed as context so the action model scopes its code.
      const reactiveHint = 'DIRECT human command (reactive mode): do EXACTLY what is asked and NOTHING more — the smallest action that satisfies it. "find"/"search"/"locate"/"recherche"/"trouve" a resource = walkToEntity to it and report what you see; do NOT place, craft, fuel, mine, or build ANYTHING unless the command explicitly says to. Do NOT reuse a learned skill that does more than the command asks. The command may be in French.'
      // eslint-disable-next-line no-unmodified-loop-condition -- `running` is flipped by stop() through the closure
      while (running) {
        if (pendingRedirect) {
          const objective = pendingRedirect
          pendingRedirect = null
          await runOneObjective(objective, reactiveHint)
        }
        else {
          await new Promise<void>((resolve) => {
            reactiveWaiter = resolve
          })
        }
      }
      return
    }

    if (deps.curriculumEnabled) {
      // eslint-disable-next-line no-unmodified-loop-condition -- `running` is flipped by stop() through the closure
      for (let i = 1; i <= deps.maxObjectives && running; i++) {
        let objective: string
        let context = ''
        let successCheck: SuccessCheck | undefined

        if (pendingRedirect) {
          objective = pendingRedirect
          pendingRedirect = null
          logger.withFields({ objective }).log('Following a human chat redirection')
        }
        else {
          const state = await captureState()
          // Show the curriculum the FACTORY (machines + status + what each drill mines)
          // and the production totals — without these it can't tell that nothing is
          // automated yet, and keeps proposing manual-grind stockpile objectives.
          const factorySummary = summarizeScan(await captureScan())
          // What ore is within reach right now (+ distance), so the curriculum advances to
          // "place the drill here" instead of re-proposing "find iron" while standing on it.
          const resScan = await captureResources()
          const ro = resScan.origin ?? { x: 0, y: 0 }
          const resourcesSummary = Object.entries(resScan.resources)
            .map(([name, r]) => `${name} x${r.count} near (${r.x},${r.y}) d${Math.round(Math.hypot(r.x - ro.x, r.y - ro.y))}`)
            .join(' | ') || undefined
          // The local ASCII map for the planner (centred on the player).
          const mapView = await captureMap(state.position)
          const production = await captureProduction()
          const productionSummary = production
            ? Object.entries(production).filter(([, c]) => c > 0).map(([item, c]) => `${item}: ${c}`).join(', ') || undefined
            : undefined
          // A single LLM timeout/stall returns null here — it must NOT kill the whole run.
          // Retry the proposal a few times (the cloud relay usually recovers on the next call)
          // before giving up, so one transient hiccup doesn't end an otherwise healthy session.
          // When the last objective failed 2+ times in a row, hard-forbid re-proposing it —
          // this is the code guard that breaks the ~50x infinite loop the prompt alone didn't.
          const forbidObjective = (repeatCount >= 2 && lastFailedObjective) ? lastFailedObjective : undefined
          let proposed: Awaited<ReturnType<typeof proposeNextObjective>> = null
          // eslint-disable-next-line no-unmodified-loop-condition -- `running` is flipped by stop() through the closure
          for (let r = 1; r <= 3 && !proposed && running; r++) {
            proposed = await proposeNextObjective({
              ultimateGoal: deps.ultimateGoal,
              state,
              factorySummary,
              resourcesSummary,
              mapView,
              productionSummary,
              skills: library.summary(),
              completed,
              failedDetails,
              forbidObjective,
              model: deps.actionModel,
            })
            // If the model ignored the ban and re-proposed the forbidden objective, reject it
            // and retry so the loop can't re-run the stuck objective a third+ time.
            if (proposed && forbidObjective && normObjective(proposed.objective) === normObjective(forbidObjective)) {
              logger.withFields({ objective: proposed.objective }).warn('Curriculum re-proposed a forbidden (stuck) objective; rejecting and retrying')
              proposed = null
            }
            if (!proposed) {
              logger.withFields({ try: r }).warn('Curriculum produced no usable objective; retrying')
            }
          }
          if (!proposed) {
            logger.warn('Curriculum produced no objective after 3 tries; stopping.')
            break
          }
          objective = proposed.objective
          context = proposed.context
          successCheck = proposed.successCheck
          logger.withFields({ step: i, objective, reasoning: proposed.reasoning, successCheck }).log('Curriculum proposed the next objective')
        }

        await runOneObjective(objective, context, successCheck)
      }
    }
    else {
      for (const objective of deps.objectives) {
        if (!running) {
          break
        }
        await runOneObjective(objective, '')
      }
    }

    logger.withFields({ completed: completed.length, failed: failedDetails.length, knownSkills: library.size() }).log('Learning session finished. Idle.')
  }

  void loop()

  return {
    onSettled: (result, detail) => settleBus.settle(result, detail),
    onResult: data => settleBus.result(data),
    onChat: (username, message) => {
      logger.withContext('chat').log(`${username}: ${message}`)
      // A human chat line is the next objective (a redirection in curriculum mode, the SOLE
      // driver in reactive mode). Wake the reactive loop if it's idle-waiting for a command.
      pendingRedirect = message
      if (reactiveWaiter) {
        reactiveWaiter()
        reactiveWaiter = null
      }
    },
    onPerception: text => logger.withContext('perception').debug(text),
    stop: () => {
      running = false
      if (reactiveWaiter) {
        reactiveWaiter()
        reactiveWaiter = null
      }
      settleBus.cancel()
    },
  }
}

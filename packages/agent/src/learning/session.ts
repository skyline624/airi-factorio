import type { GameState } from './types'
import { useLogg } from '@guiiai/logg'
import { generateCode } from './action'
import { attemptObjective } from './attempt'
import { verify } from './critic'
import { proposeNextObjective } from './curriculum'
import { createOps, extractEntryName, runSkill } from './runtime'
import { createSettleBus } from './settle-bus'
import { createSkillLibrary } from './skill-library'
import { captureState as captureStateFn } from './state'

const logger = useLogg('learning').useGlobalConfig()

export interface LearningSessionDeps {
  /** Send a full `/c ...` console command and resolve with the rcon output. */
  raw: (input: string) => Promise<string>
  /** Say a line in the in-game chat. */
  say: (message: string) => Promise<void>
  /** When true, the curriculum proposes objectives; otherwise the fixed `objectives` list is used. */
  curriculumEnabled: boolean
  /** The end goal the curriculum works toward. */
  ultimateGoal: string
  /** Max objectives to run in this session (bounds an autonomous run). */
  maxObjectives: number
  /** Fixed objectives (used when curriculumEnabled is false). */
  objectives: string[]
  actionModel: string
  criticModel: string
  embeddingModel: string
  embeddingBaseUrl: string
  skillsDir: string
  sandboxTimeoutMs: number
  settleTimeoutMs: number
  maxOpsPerSkill: number
  maxRetries: number
}

export interface LearningController {
  /** Fed by the WS reader when the mod prints a per-op result. */
  onSettled: (result: 'completed' | 'error', detail?: string) => void
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
  const captureState = (): Promise<GameState> => captureStateFn(deps.raw)

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
  const completed: string[] = []
  const failed: string[] = []

  async function runOneObjective(objective: string, context: string) {
    await deps.say(`New objective: ${objective}`).catch(() => {})

    const skills = await library.retrieve(`${objective} ${context}`.trim())
    if (skills.length) {
      logger.withFields({ skills: skills.map(s => s.name) }).log('Retrieved relevant learned skills')
    }

    const result = await attemptObjective(objective, context, {
      makeOps,
      captureState,
      resetTasks,
      generateCode,
      verify,
      skills,
      actionModel: deps.actionModel,
      criticModel: deps.criticModel,
      sandboxTimeoutMs: deps.sandboxTimeoutMs,
      maxRetries: deps.maxRetries,
      log: message => logger.log(message),
    })

    if (result.success && result.code) {
      const name = extractEntryName(result.code)
      const stored = name ? await library.add({ name, code: result.code, objective }) : null
      completed.push(objective)
      logger.withFields({ attempts: result.attempts, skill: stored?.name, description: stored?.description }).log('✅ Objective achieved and skill stored')
      await deps.say(`Done: ${objective}`).catch(() => {})
    }
    else {
      failed.push(objective)
      logger.withFields({ attempts: result.attempts, critique: result.verdict?.critique }).warn('❌ Objective not achieved within the retry budget')
      await deps.say(`I could not finish: ${objective}`).catch(() => {})
    }
  }

  async function loop() {
    logger.withFields({ curriculum: deps.curriculumEnabled, ultimateGoal: deps.ultimateGoal, maxObjectives: deps.maxObjectives, knownSkills: library.size() }).log('Learning session started (steps 3+4+5: action-as-code + skill library + curriculum)')

    if (deps.curriculumEnabled) {
      // eslint-disable-next-line no-unmodified-loop-condition -- `running` is flipped by stop() through the closure
      for (let i = 1; i <= deps.maxObjectives && running; i++) {
        let objective: string
        let context = ''

        if (pendingRedirect) {
          objective = pendingRedirect
          pendingRedirect = null
          logger.withFields({ objective }).log('Following a human chat redirection')
        }
        else {
          const state = await captureState()
          const proposed = await proposeNextObjective({
            ultimateGoal: deps.ultimateGoal,
            state,
            skills: library.summary(),
            completed,
            failed,
            model: deps.actionModel,
          })
          if (!proposed) {
            logger.warn('Curriculum produced no objective; stopping.')
            break
          }
          objective = proposed.objective
          context = proposed.context
          logger.withFields({ step: i, objective, reasoning: proposed.reasoning }).log('Curriculum proposed the next objective')
        }

        await runOneObjective(objective, context)
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

    logger.withFields({ completed: completed.length, failed: failed.length, knownSkills: library.size() }).log('Learning session finished. Idle.')
  }

  void loop()

  return {
    onSettled: (result, detail) => settleBus.settle(result, detail),
    onChat: (username, message) => {
      logger.withContext('chat').log(`${username}: ${message}`)
      // A human chat line redirects the next objective.
      pendingRedirect = message
    },
    onPerception: text => logger.withContext('perception').debug(text),
    stop: () => {
      running = false
      settleBus.cancel()
    },
  }
}

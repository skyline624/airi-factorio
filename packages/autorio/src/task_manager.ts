import type { AutorioStorage, PlayerParameters } from './types'
import { TaskStates } from './types'
import { get_player } from './utils/player'

// All mutable mod state lives in Factorio's `storage` table so it survives
// save/load and stays deterministic across multiplayer clients. Call this from
// on_init / on_configuration_changed (and defensively before use) to make sure
// the expected fields exist before anything reads them.
export function init_storage(): void {
  const s = storage as Partial<AutorioStorage>
  if (s.player_state === undefined) {
    storage.player_state = { task_state: TaskStates.IDLE }
  }
  if (s.task_queue === undefined) {
    storage.task_queue = []
  }
  if (s.setup_complete === undefined) {
    storage.setup_complete = false
  }
}

export function new_task_manager() {
  function add_task(task: PlayerParameters) {
    storage.task_queue.push(task)
    log(`[AUTORIO] Task added: ${task.type}, task queue length: ${storage.task_queue.length}`)

    if (storage.task_queue.length === 1) {
      next_task()
    }
  }

  function reset_task_state() {
    storage.player_state.task_state = TaskStates.IDLE
    storage.player_state.parameters_walk_to_entity = undefined
    storage.player_state.parameters_walking_direct = undefined
    storage.player_state.parameters_mine_entity = undefined
    storage.player_state.parameters_place_entity = undefined
    storage.player_state.parameters_move_items = undefined
    storage.player_state.parameters_craft_item = undefined
    storage.player_state.parameters_attack_nearest_enemy = undefined
    storage.player_state.parameters_research_technology = undefined
    storage.player_state.parameters_waiting = undefined
  }

  function next_task() {
    if (storage.player_state.task_state !== TaskStates.IDLE) {
      log('[AUTORIO] Task state is not IDLE, wont execute next task')
      return
    }

    const task = storage.task_queue.shift()
    if (!task) {
      storage.player_state.task_state = TaskStates.IDLE
      game.print('[AUTORIO] All operations completed')
      log('[AUTORIO] All operations completed')
      return
    }

    log(`[AUTORIO] Next task: ${task.type}, task queue length: ${storage.task_queue.length}`)
    storage.player_state.task_state = task.type
    switch (task.type) {
      case TaskStates.WALKING_TO_ENTITY:
        storage.player_state.parameters_walk_to_entity = task
        break
      case TaskStates.WALKING_DIRECT:
        storage.player_state.parameters_walking_direct = task
        break
      case TaskStates.MINING:
        storage.player_state.parameters_mine_entity = task
        break
      case TaskStates.PLACING:
        storage.player_state.parameters_place_entity = task
        break
      case TaskStates.MOVING_ITEMS:
        storage.player_state.parameters_move_items = task
        break
      case TaskStates.CRAFTING:{
        const player = get_player()
        if (!player) {
          log('[AUTORIO] No player found')
          return
        }

        player.begin_crafting({
          count: task.count,
          recipe: task.item_name,
        })

        storage.player_state.parameters_craft_item = task
        break
      }
      case TaskStates.ATTACKING:
        storage.player_state.parameters_attack_nearest_enemy = task
        break
      case TaskStates.RESEARCHING:
        storage.player_state.parameters_research_technology = task
        break
      case TaskStates.WAITING:
        storage.player_state.parameters_waiting = task
        break
    }
  }

  function is_task_queue_empty() {
    return storage.task_queue.length === 0
  }

  function cancel_task() {
    reset_task_state()
  }

  function cancel_all_tasks() {
    reset_task_state()
    storage.task_queue.length = 0 // can use this to clear the array in lua
  }

  return {
    add_task,
    next_task,
    is_task_queue_empty,
    reset_task_state,
    cancel_task,
    cancel_all_tasks,
  }
}

import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, PathfinderWaypoint } from 'factorio:runtime'

export enum TaskStates {
  IDLE = 'idle',
  WALKING_TO_ENTITY = 'walking_to_entity',
  MINING = 'mining',
  PLACING = 'placing',
  PLACING_AT = 'placing_at',
  PLACING_IN_CHEST = 'placing_in_chest',
  PICKING_UP = 'picking_up',
  CRAFTING = 'crafting',
  RESEARCHING = 'researching',
  WALKING_DIRECT = 'walking_direct',
  MOVING_ITEMS = 'moving_items',
  ATTACKING = 'attacking',
  WAITING = 'waiting',
}

export interface PlayerParametersWalkToEntity {
  type: TaskStates.WALKING_TO_ENTITY
  entity_name: string
  search_radius: number
  path: PathfinderWaypoint[] | null
  path_drawn: boolean
  path_index: number
  calculating_path: boolean
  target_position: MapPositionStruct | null
  // Stuck detection while following a path: the character's position last tick, how many
  // consecutive no-progress ticks we've seen, and how many times we've recomputed a fresh
  // path. Lets us route around obstacles (or fail cleanly) instead of shoving forever.
  last_position?: MapPositionStruct
  stuck_ticks?: number
  recompute_count?: number
}

export interface PlayerParametersWalkingDirect {
  type: TaskStates.WALKING_DIRECT
  target_position: MapPositionStruct | null
  // Stuck handling for the dumb straight-line walk (the fallback when pathfinding
  // failed outright). When the character stops advancing — wedged in trees — we
  // mine the organic obstacles around it and keep going, bounded by a clear cap.
  last_position?: MapPositionStruct
  stuck_ticks?: number
  clears?: number
}

export interface PlayerParametersMineEntity {
  type: TaskStates.MINING
  entity_name: string
  count: number
  position?: MapPositionStruct
  // Ticks spent re-issuing a mine without anything actually getting mined — i.e. the
  // target is within the search radius but beyond the character's mining REACH. Used
  // to abort cleanly instead of spamming "Started mining" forever. Reset on a mine.
  stall_ticks?: number
}

export interface PlayerParametersPlaceEntity {
  type: TaskStates.PLACING
  entity_name: string
  position?: MapPositionStruct
}

// Precise, directional placement (no snapping). `direction` is a defines.direction
// int, mapped from a string at enqueue time so storage stays primitive-only.
export interface PlayerParametersPlaceEntityAt {
  type: TaskStates.PLACING_AT
  entity_name: string
  x: number
  y: number
  direction: number
}

export interface PlayerParametersMoveItems {
  type: TaskStates.MOVING_ITEMS
  item_name: string
  entity_name: string
  max_count: number
  to_entity: boolean // If true, the items will be moved to the entity, otherwise, the items will be moved to the player's inventory
}

export interface PlayerParametersCraftItem {
  type: TaskStates.CRAFTING
  item_name: string
  count: number
  crafted: number
}

export interface PlayerParametersAttackNearestEnemy {
  type: TaskStates.ATTACKING
  search_radius: number
  target: LuaEntity | null
  ticks_elapsed: number
}

export interface PlayerParametersResearchTechnology {
  type: TaskStates.RESEARCHING
  technology_name: string
}

export interface PlayerParametersWaiting {
  type: TaskStates.WAITING
  remaining_ticks: number
}

export type PlayerParameters
  = | PlayerParametersWalkToEntity
    | PlayerParametersWalkingDirect
    | PlayerParametersMineEntity
    | PlayerParametersPlaceEntity
    | PlayerParametersPlaceEntityAt
    | PlayerParametersMoveItems
    | PlayerParametersCraftItem
    | PlayerParametersAttackNearestEnemy
    | PlayerParametersResearchTechnology
    | PlayerParametersWaiting

export interface PlayerState {
  task_state: TaskStates
  parameters_walk_to_entity?: PlayerParametersWalkToEntity
  parameters_walking_direct?: PlayerParametersWalkingDirect
  parameters_mine_entity?: PlayerParametersMineEntity
  parameters_place_entity?: PlayerParametersPlaceEntity
  parameters_place_entity_at?: PlayerParametersPlaceEntityAt
  parameters_move_items?: PlayerParametersMoveItems
  parameters_craft_item?: PlayerParametersCraftItem
  parameters_attack_nearest_enemy?: PlayerParametersAttackNearestEnemy
  parameters_research_technology?: PlayerParametersResearchTechnology
  parameters_waiting?: PlayerParametersWaiting
}

// Perception state: small primitives only (no LuaEntity — those can become
// invalid between ticks). Used to throttle alerts and detect transitions.
export interface PerceptionState {
  last_damage_tick: number
  last_damage_alert_tick: number
  under_attack: boolean
  low_health_alerted: boolean
  last_enemy_count: number
  last_enemy_scan_tick: number
  structures_lost_pending: number
  last_structure_alert_tick: number
}

// Shape of Factorio's `storage` table for this mod. Keeping all mutable state
// here (instead of module-level locals) is what makes it survive save/load and
// stay deterministic across multiplayer clients.
export interface AutorioStorage {
  player_state: PlayerState
  task_queue: PlayerParameters[]
  setup_complete: boolean
  perception: PerceptionState
}

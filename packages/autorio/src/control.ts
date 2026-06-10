import type { MapPosition, MapPositionStruct } from 'factorio:prototype'
import type {
  BoundingBoxArray,
  CollisionMask,
  EquipmentPosition,
  LuaEntity,
  LuaInventory,
  LuaPlayer,
  OnEntityDamagedEvent,
  OnEntityDiedEvent,
  OnPlayerCraftedItemEvent,
  OnPlayerDiedEvent,
  OnPlayerMinedEntityEvent,
  OnScriptPathRequestFinishedEvent,
  OnSelectedEntityChangedEvent,
  PathfinderWaypoint,
  SurfaceCreateEntity,
} from 'factorio:runtime'

import type { InventoryItem } from './utils/inventory'
import { init_storage, new_task_manager } from './task_manager'
import { create_tools_remote_interface } from './tools'
import { TaskStates } from './types'
import { get_nearest_entity } from './utils/entity'
import { get_inventory_items } from './utils/inventory'
import { distance } from './utils/math'
import { get_player } from './utils/player'

// Perception tuning (constants, not mutable state — safe outside storage).
const damage_alert_interval = 120 // ticks (~2s) between two `damaged` events
const under_attack_timeout = 300 // ticks (~5s) without damage clears under_attack
const low_health_ratio = 0.3 // health ratio threshold for the low_health alert
const enemy_scan_interval = 30 // ticks between nearby-enemy scans
const enemy_scan_radius = 30 // tiles
const structure_alert_interval = 120 // ticks between aggregated structure_lost events

create_tools_remote_interface()

const task_manager = new_task_manager()

script.on_init(() => {
  init_storage()
})

script.on_configuration_changed(() => {
  init_storage()
})

function log_player_info(player_id: number) {
  const player = get_player(player_id)
  if (!player) {
    log(`[AUTORIO] No player found for id ${player_id}`)
    return
  }
  const log_data: {
    name: string
    position: MapPosition
    force: string
    inventory: InventoryItem[]
    equipment: { name: string, position: EquipmentPosition }[]
    nearby_entities: { name: string, position: MapPosition }[]
    map_info: {
      surface_name: string
      daytime: number
      wind_speed: number
      wind_orientation: number
    }
    research: {
      current_research: string
      research_progress: number
    }
    technologies: string[]
    crafting_queue: { name: string, count: number }[]
    character_stats: {
      health: number | undefined
      health_max: number
      mining_progress: number | undefined
      mining_target: LuaEntity | undefined
      vehicle: string
    }
  } = {
    name: player.name,
    position: player.position,
    force: player.force.name,
    inventory: [],
    equipment: [],
    nearby_entities: [],
    map_info: {
      surface_name: player.surface.name,
      daytime: player.surface.daytime,
      wind_speed: player.surface.wind_speed,
      wind_orientation: player.surface.wind_orientation,
    },
    research: {
      current_research: player.force.current_research?.name ?? 'None',
      research_progress: player.force.research_progress,
    },
    technologies: [],
    crafting_queue: [],
    character_stats: {
      health: undefined,
      health_max: 0,
      mining_progress: undefined,
      mining_target: undefined,
      vehicle: 'None',
    },
  }

  log_data.inventory = get_inventory_items(player_id)

  if (player.character?.grid) {
    player.character.grid.equipment.forEach(({ name, position }) => {
      log_data.equipment.push({ name, position })
    })
  }

  const nearby_entities = player.surface.find_entities_filtered({
    position: player.position,
    radius: 20,
  })
  nearby_entities.forEach(({ name, position }) => {
    log_data.nearby_entities.push({ name, position })
  })

  for (const [name, tech] of pairs(player.force.technologies)) {
    if (tech.researched) {
      log_data.technologies.push(name)
    }
  }

  for (let i = 1; i < player.crafting_queue_size; i++) {
    const item = player.crafting_queue?.[i]
    if (item) {
      log_data.crafting_queue.push({ name: item.recipe, count: item.count })
    }
  }

  if (player.character) {
    log_data.character_stats = {
      health: player.character.health,
      health_max: player.character.max_health,
      mining_progress: player.character.mining_progress,
      mining_target: player.character.mining_target,
      vehicle: player.vehicle?.name ?? 'None',
    }
  }

  log(`[AUTORIO] Player ${player.name} info: ${serpent.block(log_data)}`)
}

remote.add_interface('autorio_operations', {
  walk_to_entity: (entity_name: string, search_radius: number) => {
    log(`[AUTORIO] New walk_to_entity task: ${entity_name}, radius: ${search_radius}`)
    task_manager.add_task({
      type: TaskStates.WALKING_TO_ENTITY,
      entity_name,
      search_radius,
      path: null,
      path_drawn: false,
      path_index: 1,
      calculating_path: false,
      target_position: null,
    })

    return true
  },

  mine_entity: (entity_name: string, count: number = 1) => {
    task_manager.add_task({
      type: TaskStates.MINING,
      entity_name,
      count,
    })

    log(`[AUTORIO] New mine_entity task: ${entity_name} x${count}`)
    return true
  },
  place_entity: (entity_name: string) => {
    task_manager.add_task({
      type: TaskStates.PLACING,
      entity_name,
      position: undefined,
    })

    log(`[AUTORIO] New place_entity task: ${entity_name}`)
    return true
  },
  place_entity_at: (entity_name: string, x: number, y: number, direction: string) => {
    task_manager.add_task({
      type: TaskStates.PLACING_AT,
      entity_name,
      x,
      y,
      direction: direction_from_name(direction),
    })

    log(`[AUTORIO] New place_entity_at task: ${entity_name} at (${x},${y}) dir=${direction}`)
    return true
  },
  move_items: (item_name: string, entity_name: string, max_count: number, to_entity: boolean): [boolean, string] => {
    task_manager.add_task({
      type: TaskStates.MOVING_ITEMS,
      item_name,
      entity_name,
      max_count: max_count || math.huge,
      to_entity,
    })

    if (to_entity) {
      log(`[AUTORIO] New move_items task for ${item_name} from player's inventory to ${entity_name}`)
    }
    else {
      log(`[AUTORIO] New move_items task for ${item_name} from ${entity_name} to player's inventory`)
    }

    return [true, 'Task started']
  },
  wait: (ticks: number): [boolean, string] => {
    task_manager.add_task({
      type: TaskStates.WAITING,
      remaining_ticks: ticks,
    })

    log(`[AUTORIO] New wait task for ${ticks} ticks`)

    return [true, 'Task started']
  },
  craft_item: (item_name: string, count: number = 1): [boolean, string] => {
    const player = get_player()
    if (!player) {
      return [false, 'No player found']
    }
    if (!player.force.recipes[item_name]) {
      log('[AUTORIO] Cannot start craft_item task: Recipe not available')
      return [false, 'Recipe not available']
    }
    if (!player.force.recipes[item_name].enabled) {
      log('[AUTORIO] Cannot start craft_item task: Recipe not unlocked')
      return [false, 'Recipe not unlocked']
    }

    if (!check_can_craft(player, item_name, count)) {
      return [false, 'Not enough ingredients']
    }

    task_manager.add_task({
      type: TaskStates.CRAFTING,
      item_name,
      count,
      crafted: 0,
    })

    log(`[AUTORIO] New craft_item task: ${item_name} x${count}`)
    return [true, 'Task started']
  },
  attack_nearest_enemy: (search_radius: number = 50): [boolean, string] => {
    task_manager.add_task({
      type: TaskStates.ATTACKING,
      search_radius,
      target: null,
      ticks_elapsed: 0,
    })

    log(`[AUTORIO] New attack nearest enemy task, search radius: ${search_radius}`)
    return [true, 'Task started']
  },
  research_technology: (technology_name: string): [boolean, string] => {
    const player = get_player()
    if (!player) {
      return [false, 'No player found']
    }
    const force = player.force
    const tech = force.technologies[technology_name]

    if (!tech) {
      log('[AUTORIO] [ERROR] Cannot start research: technology not found')
      return [false, 'Technology not found']
    }

    if (tech.researched) {
      log('[AUTORIO] Cannot start research_technology task: Technology already researched')
      return [false, 'Technology already researched']
    }

    if (!tech.enabled) {
      log('[AUTORIO] Cannot start research_technology task: Technology not available for research')
      return [false, 'Technology not available for research']
    }

    const research_added = force.add_research(tech)
    if (research_added) {
      log(`[AUTORIO] New research_technology task: ${technology_name}`)
      return [true, 'Research started']
    }
    log('[AUTORIO] [ERROR] Could not start new research')
    return [false, 'Cannot start new research']
  },
  cancel_all_tasks: () => {
    task_manager.cancel_all_tasks()
    return true
  },
  log_player_info: (player_id: number) => {
    log_player_info(player_id)
    return true
  },
})

// Map a human-friendly direction string (from the LLM) to a defines.direction.
// Unknown/undefined falls back to north. (Factorio 2.0 is 16-way: N=0,E=4,S=8,W=12.)
function direction_from_name(name: string) {
  switch (name) {
    case 'east':
      return defines.direction.east
    case 'south':
      return defines.direction.south
    case 'west':
      return defines.direction.west
    case 'northeast':
      return defines.direction.northeast
    case 'southeast':
      return defines.direction.southeast
    case 'southwest':
      return defines.direction.southwest
    case 'northwest':
      return defines.direction.northwest
    default:
      return defines.direction.north
  }
}

function get_direction(start_position: MapPositionStruct, end_position: MapPositionStruct) {
  const angle = math.atan2(end_position.y - start_position.y, start_position.x - end_position.x)
  const octant = (angle + math.pi) / (2 * math.pi) * 8 + 0.5

  if (octant < 1) {
    return defines.direction.east
  }
  if (octant < 2) {
    return defines.direction.northeast
  }
  if (octant < 3) {
    return defines.direction.north
  }
  if (octant < 4) {
    return defines.direction.northwest
  }
  if (octant < 5) {
    return defines.direction.west
  }
  if (octant < 6) {
    return defines.direction.southwest
  }
  if (octant < 7) {
    return defines.direction.south
  }
  return defines.direction.southeast
}

function start_mining(player: LuaPlayer, entity_position: MapPositionStruct) {
  player.update_selected_entity(entity_position)
  player.mining_state = { mining: true, position: entity_position } // should not use player.mine_entity() because it will skip the mining animation
  log(`[AUTORIO] Started mining at position: ${serpent.line(entity_position)}`)
}

// FIXME: who are changing the selected entity while mining?
// This only happens in multiplayer, why?
script.on_event(defines.events.on_selected_entity_changed, (unused_event: OnSelectedEntityChangedEvent) => {})

script.on_event(defines.events.on_script_path_request_finished, (event: OnScriptPathRequestFinishedEvent) => {
  if (storage.player_state.task_state !== TaskStates.WALKING_TO_ENTITY) {
    log('[AUTORIO] Not walking to entity, ignoring path request')
    return
  }

  if (!storage.player_state.parameters_walk_to_entity) {
    log('[AUTORIO] No parameters found when receiving path request')
    return
  }

  if (!event.path) {
    log('[AUTORIO] Path calculation failed, switching to direct walking')
    storage.player_state.task_state = TaskStates.WALKING_DIRECT
    storage.player_state.parameters_walking_direct = {
      type: TaskStates.WALKING_DIRECT,
      target_position: storage.player_state.parameters_walk_to_entity.target_position,
    }
    storage.player_state.parameters_walk_to_entity = undefined
    return
  }

  storage.player_state.parameters_walk_to_entity.path = event.path
  storage.player_state.parameters_walk_to_entity.path_drawn = false
  storage.player_state.parameters_walk_to_entity.path_index = 1
  storage.player_state.parameters_walk_to_entity.calculating_path = false
  log(`[AUTORIO] Path calculation completed. Path length: ${event.path}`)
})

script.on_event(defines.events.on_player_mined_entity, (unused_event: OnPlayerMinedEntityEvent) => {
  if (storage.player_state.task_state !== TaskStates.MINING) {
    return
  }

  if (!storage.player_state.parameters_mine_entity) {
    log('[AUTORIO] No parameters found when on_player_mined_entity event')
    return
  }

  storage.player_state.parameters_mine_entity.count = storage.player_state.parameters_mine_entity.count - 1
  storage.player_state.parameters_mine_entity.stall_ticks = 0 // real progress — reset the out-of-reach guard

  if (storage.player_state.parameters_mine_entity.count <= 0) {
    log('[AUTORIO] Mining task complete, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
  }
})

script.on_event(defines.events.on_entity_damaged, (event: OnEntityDamagedEvent) => {
  const player = event.entity.player
  if (!player || player.index !== 1) {
    return
  }

  storage.perception.last_damage_tick = game.tick
  storage.perception.under_attack = true

  if (game.tick - storage.perception.last_damage_alert_tick >= damage_alert_interval) {
    storage.perception.last_damage_alert_tick = game.tick
    const max_health = event.entity.max_health
    const ratio = max_health > 0 ? math.floor((event.final_health / max_health) * 100) / 100 : 0
    log(`[AUTORIO] [EVENT] damaged health=${event.final_health} max_health=${max_health} ratio=${ratio} cause=${event.cause?.name ?? 'unknown'} damage_type=${event.damage_type.name}`)
  }
}, [{ filter: 'type', type: 'character' }])

script.on_event(defines.events.on_player_died, (event: OnPlayerDiedEvent) => {
  if (event.player_index !== 1) {
    return
  }
  storage.perception.under_attack = false
  storage.perception.low_health_alerted = false
  log(`[AUTORIO] [EVENT] died cause=${event.cause?.name ?? 'unknown'}`)
})

script.on_event(defines.events.on_entity_died, (event: OnEntityDiedEvent) => {
  if (event.entity.type === 'character') {
    return // player death is handled by on_player_died
  }
  storage.perception.structures_lost_pending += 1
}, [{ filter: 'force', force: 'player' }])

function setup() {
  const surface = game.surfaces[1]
  const enemies = surface.find_entities_filtered({ force: 'enemy' })
  log(`[AUTORIO] Removing ${enemies.length} enemies`)
  for (const enemy of enemies) {
    enemy.destroy()
  }

  storage.setup_complete = true
  log('[AUTORIO] Setup complete')
}

function draw_path(player: LuaPlayer, path: PathfinderWaypoint[]) {
  for (let i = 0; i < path.length - 1; i++) {
    rendering.draw_line({
      color: { r: 0, g: 1, b: 0 },
      width: 2,
      from: path[i].position,
      to: path[i + 1].position,
      surface: player.surface,
      time_to_live: 600,
      draw_on_ground: true,
    })
  }
}

// Path-following robustness: how close (tiles) counts as "reached" a waypoint, the per-tick
// movement below which we count as no-progress, how many consecutive no-progress ticks means
// the hop to the next waypoint is blocked, how many fresh-path recomputes we try before giving
// up, after how many failed pure-pathfinding recomputes we start clearing the way, and the
// radius (tiles) within which we then destroy blocking trees/rocks.
const WAYPOINT_REACHED = 0.35
const STUCK_PROGRESS_EPS = 0.03
const STUCK_TICKS = 45
const MAX_PATH_RECOMPUTES = 6
const DESTROY_AFTER_RECOMPUTES = 2
const OBSTACLE_CLEAR_RADIUS = 2.5

function follow_path(player: LuaPlayer, path: PathfinderWaypoint[]) {
  if (path.length === 0) {
    return true
  }

  // check if reached next waypoint
  const next_position = path[0].position
  const d = distance(next_position, player.position)
  if (d < WAYPOINT_REACHED) {
    path.shift()
    return false
  }

  // move towards next waypoint
  const direction = get_direction(player.position, next_position)
  player.walking_state = {
    walking: true,
    direction,
  }

  return false
}

// "Destroy when needed" escape hatch: clear organic obstacles (trees, rocks) within reach
// when the character is wedged and pathfinding alone can't get out. Never touches the
// player's own buildings or ore resources. Returns how many entities were cleared.
function clear_obstacles_near(player: LuaPlayer): number {
  const obstacles = player.surface.find_entities_filtered({
    position: player.position,
    radius: OBSTACLE_CLEAR_RADIUS,
    type: ['tree', 'simple-entity'],
  })
  let n = 0
  for (const o of obstacles) {
    if (o.valid) {
      o.destroy()
      n = n + 1
    }
  }
  return n
}

// If the character ends up inside a freshly-placed entity's collision box, push it onto the
// nearest free tile — so the agent never boxes itself in (which would strand every later walk).
function push_character_clear(player: LuaPlayer, entity: LuaEntity) {
  const character = player.character
  if (!character || !entity.valid) {
    return
  }
  const bb = entity.bounding_box
  const cp = character.position
  if (cp.x >= bb.left_top.x && cp.x <= bb.right_bottom.x && cp.y >= bb.left_top.y && cp.y <= bb.right_bottom.y) {
    const free = player.surface.find_non_colliding_position('character', cp, 6, 0.25)
    if (free) {
      character.teleport(free)
      log(`[AUTORIO] Pushed character clear of freshly-placed ${entity.name}`)
    }
  }
}

function state_walking_to_entity(player: LuaPlayer) {
  if (!storage.player_state.parameters_walk_to_entity) {
    log('[AUTORIO] No parameters found when walking to entity')
    return
  }

  if (storage.player_state.parameters_walk_to_entity.calculating_path) {
    log('[AUTORIO] Path calculation in progress, skipping')
    return
  }

  const params = storage.player_state.parameters_walk_to_entity

  // follow path
  if (params.path) {
    if (!params.path_drawn) {
      draw_path(player, params.path)
      params.path_drawn = true
      log('[AUTORIO] Path drawn on ground')
    }

    // Stuck detection: if the character stops advancing, the straight-line hop to the next
    // waypoint is blocked (typically a tree the route grazes). Recompute a fresh path from
    // the current spot — the pathfinder routes around objects — bounded by MAX_PATH_RECOMPUTES
    // so we fail cleanly instead of shoving against the obstacle until the op times out.
    const moved = params.last_position ? distance(player.position, params.last_position) : 999
    params.last_position = { x: player.position.x, y: player.position.y }
    params.stuck_ticks = moved < STUCK_PROGRESS_EPS ? (params.stuck_ticks ?? 0) + 1 : 0

    if (params.stuck_ticks >= STUCK_TICKS) {
      params.recompute_count = (params.recompute_count ?? 0) + 1
      player.walking_state = { walking: false, direction: player.walking_state.direction }
      rendering.clear()
      if (params.recompute_count > MAX_PATH_RECOMPUTES) {
        log(`[AUTORIO] [ERROR] Stuck walking to ${params.entity_name}: no navigable path after ${MAX_PATH_RECOMPUTES} recomputes, aborting`)
        task_manager.cancel_all_tasks()
        return
      }
      // Pathfinding first; once a couple of pure recomputes haven't helped, clear the
      // organic obstacles (trees/rocks) physically blocking the way, then recompute.
      if (params.recompute_count >= DESTROY_AFTER_RECOMPUTES) {
        const cleared = clear_obstacles_near(player)
        if (cleared > 0) {
          log(`[AUTORIO] Cleared ${cleared} blocking tree(s)/rock(s) to free the route`)
        }
      }
      log(`[AUTORIO] Stuck following path, recomputing fresh route (attempt ${params.recompute_count}/${MAX_PATH_RECOMPUTES})`)
      params.path = null
      params.path_drawn = false
      params.last_position = undefined
      params.stuck_ticks = 0
      // fall through to the path-calculation branch below to request a new route
    }
    else {
      if (follow_path(player, params.path)) {
        log('[AUTORIO] Task completed, switching to IDLE state')
        // Stop the character. Without this, Factorio keeps applying the last walking_state
        // (walking: true) so the player runs past the target — and the next op (place/mine)
        // then happens at the wrong spot.
        player.walking_state = { walking: false, direction: player.walking_state.direction }
        rendering.clear()
        task_manager.reset_task_state()
        task_manager.next_task()
      }

      return
    }
  }

  // find nearest entity and calculate path. The agent passes an arbitrary string;
  // find_entities_filtered{name=...} THROWS and crashes on_tick if it isn't a real
  // entity NAME (e.g. 'tree', which is a TYPE — trees are named tree-01, …). Resolve
  // it: a real prototype name -> name filter; otherwise treat it as a type ('tree',
  // 'resource', …); if it's neither, fail cleanly instead of crashing the whole mod.
  const target_name = storage.player_state.parameters_walk_to_entity.entity_name
  const search_radius = storage.player_state.parameters_walk_to_entity.search_radius
  let entities: LuaEntity[]
  try {
    entities = prototypes.entity[target_name] !== undefined
      ? player.surface.find_entities_filtered({ position: player.position, radius: search_radius, name: target_name })
      : player.surface.find_entities_filtered({ position: player.position, radius: search_radius, type: target_name })
  }
  catch {
    log(`[AUTORIO] [ERROR] '${target_name}' is not a valid entity name or type, aborting walk`)
    task_manager.cancel_all_tasks()
    return
  }

  if (entities.length === 0) {
    log(`[AUTORIO] [ERROR] No ${storage.player_state.parameters_walk_to_entity.entity_name} found in ${storage.player_state.parameters_walk_to_entity.search_radius}m radius, reverting to IDLE state`)
    task_manager.cancel_all_tasks()
    return
  }

  const nearest_entity = get_nearest_entity(player, entities)

  log(`[AUTORIO] Nearest entity position: ${serpent.line(nearest_entity?.position)}`)
  log(`[AUTORIO] Player position: ${serpent.line(player.position)}`)
  log(`[AUTORIO] Player bounding box: ${serpent.line(player.character?.bounding_box)}`)

  if (nearest_entity && !storage.player_state.parameters_walk_to_entity.calculating_path && !storage.player_state.parameters_walk_to_entity.path) {
    const character = player.character
    if (!character) {
      log('[AUTORIO] Player character not found, aborting pathfinding')
      return
    }

    // TODO: improve path following, check if stuck on objects
    // currently using larger than character bbox as a workaround for the path following getting stuck on objects
    // may sometimes still get stuck on trees and will fail to find small passages
    const bbox: BoundingBoxArray = [[-0.5, -0.5], [0.5, 0.5]]
    const start = player.surface.find_non_colliding_position(
      'iron-chest', // TODO: using iron chest bbox so request_path doesn't fail standing near objects using the larger bbox
      character.position,
      10,
      0.5,
      false,
    )

    if (!start) {
      log('[AUTORIO] find_non_colliding_position returned nil! Aborting pathfinding.')
      return
    }

    const collision_mask: CollisionMask = {
      layers: {
        player: true,
        train: true,
        water_tile: true,
        object: true,
        // car: true,
        // cliff: true,
      },
      consider_tile_transitions: true,
    }

    player.surface.request_path({
      bounding_box: bbox,
      collision_mask,
      radius: 2,
      start,
      goal: nearest_entity.position,
      force: player.force,
      entity_to_ignore: character,
      pathfind_flags: {
        cache: false,
        no_break: true,
        prefer_straight_paths: false,
        allow_paths_through_own_entities: false,
      },
    })
    storage.player_state.parameters_walk_to_entity.calculating_path = true
    storage.player_state.parameters_walk_to_entity.target_position = nearest_entity.position
    log(`[AUTORIO] Requested path calculation to ${serpent.line(nearest_entity.position)}`)
  }
}

function state_mining(player: LuaPlayer) {
  if (!storage.player_state.parameters_mine_entity) {
    log('[AUTORIO] No parameters found when mining')
    return
  }

  if (player.mining_state.mining) {
    storage.player_state.parameters_mine_entity.stall_ticks = 0
    return
  }

  // About to (re)issue a mine. If we keep doing this and nothing ever gets mined,
  // the target sits within the search radius but BEYOND the character's mining reach
  // (the agent didn't walk close enough) — so abort cleanly instead of re-issuing
  // "Started mining" forever. on_player_mined_entity resets this on real progress.
  const mp = storage.player_state.parameters_mine_entity
  mp.stall_ticks = (mp.stall_ticks ?? 0) + 1
  if ((mp.stall_ticks ?? 0) > 90) {
    log(`[AUTORIO] [ERROR] '${mp.entity_name}' is out of mining reach (walk closer first), aborting mine`)
    task_manager.cancel_all_tasks()
    return
  }

  if (storage.player_state.parameters_mine_entity.position) {
    start_mining(player, storage.player_state.parameters_mine_entity.position)
    return
  }

  // Same name-vs-type guard as walk: 'tree' is a TYPE (the agent mines trees for
  // wood), so a raw name filter would crash on_tick. Resolve name -> type -> clean fail.
  const mine_name = storage.player_state.parameters_mine_entity.entity_name
  let entities: LuaEntity[]
  try {
    entities = prototypes.entity[mine_name] !== undefined
      ? player.surface.find_entities_filtered({ position: player.position, radius: 5, name: mine_name })
      : player.surface.find_entities_filtered({ position: player.position, radius: 5, type: mine_name })
  }
  catch {
    log(`[AUTORIO] [ERROR] '${mine_name}' is not a valid entity name or type, cannot mine`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  if (entities.length === 0) {
    log(`[AUTORIO] [ERROR] No ${storage.player_state.parameters_mine_entity.entity_name} found within reach to mine`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  const nearest_entity = get_nearest_entity(player, entities)
  if (!nearest_entity) {
    log(`[AUTORIO] [ERROR] No ${storage.player_state.parameters_mine_entity.entity_name} found within reach to mine`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  start_mining(player, nearest_entity.position)
}

function state_placing(player: LuaPlayer) {
  if (!player) {
    log('[AUTORIO] Invalid player, ending PLACING task')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid player']
  }

  if (!storage.player_state.parameters_place_entity) {
    log('[AUTORIO] No parameters found when placing')
    return
  }

  const surface = player.surface
  const inventory = player.get_main_inventory()

  if (!inventory) {
    log('[AUTORIO] [ERROR] Cannot access player inventory to place entity')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Cannot access player inventory']
  }

  const entity_prototype = prototypes.entity[storage.player_state.parameters_place_entity.entity_name]
  if (!entity_prototype || !entity_prototype.items_to_place_this) {
    log('[AUTORIO] [ERROR] Invalid entity name, cannot place')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid entity name']
  }

  const item_name = entity_prototype.items_to_place_this[0]
  if (!item_name) {
    log('[AUTORIO] [ERROR] Invalid entity name, cannot place')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid entity name']
  }

  const [item_stack, unused_count] = inventory.find_item_stack(storage.player_state.parameters_place_entity.entity_name)
  if (!item_stack) {
    log(`[AUTORIO] [ERROR] ${storage.player_state.parameters_place_entity.entity_name} not found in inventory to place`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Entity not found in inventory']
  }

  if (!storage.player_state.parameters_place_entity.position) {
    const place_name = storage.player_state.parameters_place_entity.entity_name

    // Mining drills only produce when placed ON an ore patch. Snap the drill onto the
    // nearest minable resource instead of dropping it next to the player (which leaves
    // it off the ore and idle).
    if (entity_prototype.type === 'mining-drill') {
      const resources = surface.find_entities_filtered({ position: player.position, radius: 20, type: 'resource' })
      const nearest_ore = resources.length > 0 ? get_nearest_entity(player, resources) : undefined
      if (nearest_ore) {
        storage.player_state.parameters_place_entity.position = surface.find_non_colliding_position(place_name, nearest_ore.position, 6, 0.5)
      }
      if (!storage.player_state.parameters_place_entity.position) {
        log(`[AUTORIO] [ERROR] No minable resource found near the player to place ${place_name}`)
        task_manager.cancel_all_tasks()
        return [false, 'No resource to place the mining drill on']
      }
    }
    else if (entity_prototype.type === 'furnace') {
      // Put the furnace ON the nearest drill's output so it receives ore hands-free.
      // Wide search: the agent often places the drill, wanders to mine/craft, then
      // places the furnace, so the drill can be far (create_entity ignores reach).
      const drills = surface.find_entities_filtered({ position: player.position, radius: 48, type: 'mining-drill' })
      const nearest_drill = drills.length > 0 ? get_nearest_entity(player, drills) : undefined
      let chosen: MapPositionStruct | undefined
      if (nearest_drill) {
        // The drill feeds whatever entity occupies the TILE under its drop_position.
        // Enumerate the (integer-grid) 2x2 furnace centres whose footprint covers
        // that tile, keep the placeable ones, and pick the centre FURTHEST from the
        // drill so the furnace extends away from it. This GUARANTEES drop_target ==
        // furnace — unlike find_non_colliding_position, which slid the box off the
        // drop tile to dodge the drill and silently broke the feed.
        const drop = nearest_drill.drop_position
        const dc = nearest_drill.position
        let best_dist = -1
        for (const cx of [math.floor(drop.x), math.ceil(drop.x)]) {
          for (const cy of [math.floor(drop.y), math.ceil(drop.y)]) {
            if (math.abs(drop.x - cx) >= 1 || math.abs(drop.y - cy) >= 1) {
              continue // footprint must cover the drop tile
            }
            const pos = { x: cx, y: cy }
            if (!surface.can_place_entity({ name: place_name, position: pos, force: player.force, build_check_type: defines.build_check_type.manual })) {
              continue
            }
            const dist = (cx - dc.x) * (cx - dc.x) + (cy - dc.y) * (cy - dc.y)
            if (dist > best_dist) {
              best_dist = dist
              chosen = pos
            }
          }
        }
        // Last resort if every covering tile is blocked: nearest free spot to the drop.
        if (!chosen) {
          chosen = surface.find_non_colliding_position(place_name, drop, 2, 0.5)
        }
      }
      if (!chosen) {
        // No drill nearby: just place next to the player.
        chosen = surface.find_non_colliding_position(place_name, player.position, 1, 1)
      }
      if (!chosen) {
        log('[AUTORIO] [ERROR] Could not find a valid position to place the furnace')
        task_manager.reset_task_state()
        task_manager.next_task()
        return [false, 'Could not find a valid position to place the entity']
      }
      storage.player_state.parameters_place_entity.position = chosen
    }
    else {
      storage.player_state.parameters_place_entity.position = surface.find_non_colliding_position(place_name, player.position, 1, 1)
      if (!storage.player_state.parameters_place_entity.position) {
        log('[AUTORIO] [ERROR] Could not find a valid position to place the entity')
        task_manager.reset_task_state()
        task_manager.next_task()
        return [false, 'Could not find a valid position to place the entity']
      }
    }
  }

  storage.player_state.task_state = TaskStates.IDLE
  const create_entity_args: SurfaceCreateEntity = {
    name: storage.player_state.parameters_place_entity.entity_name,
    position: storage.player_state.parameters_place_entity.position,
    force: player.force,
    raise_built: true,
    player,
  }
  const entity = surface.create_entity(create_entity_args)

  if (entity) {
    item_stack.count = item_stack.count - 1
    push_character_clear(player, entity)
    log(`[AUTORIO] Entity placed successfully: ${storage.player_state.parameters_place_entity.entity_name}`)
    // Note: a drill only reports drop_target (and reaches 'working') once it has
    // FUEL, so we can't verify the drill->furnace hookup here at placement time —
    // an unfueled drill always reads drop_target=NONE regardless of position. The
    // furnace was placed to cover the drill's drop tile (see the snap above); the
    // feed latches automatically once the drill is fueled and mining.
    if (entity_prototype.type === 'furnace') {
      const near_drills = surface.find_entities_filtered({ position: entity.position, radius: 5, type: 'mining-drill' })
      if (near_drills.length > 0) {
        log(`[AUTORIO] Furnace placed on the output tile of a drill at (${near_drills[0].position.x},${near_drills[0].position.y}) — will feed once the drill has fuel`)
      }
    }
    task_manager.reset_task_state()
    task_manager.next_task()
    return [true, 'Entity placed successfully', entity]
  }
  log(`[AUTORIO] [ERROR] Failed to place entity: ${storage.player_state.parameters_place_entity.entity_name}`)
  task_manager.reset_task_state()
  task_manager.next_task()
  return [false, 'Failed to place entity']
}

// Precise, directional placement at exact coordinates — NO snapping. Validates with
// can_place_entity (manual build check) and emits [ERROR] if blocked. This is what
// lets the agent lay aligned lines (belts, inserters, assemblers, power).
function state_placing_at(player: LuaPlayer) {
  const params = storage.player_state.parameters_place_entity_at
  if (!params) {
    log('[AUTORIO] No parameters found when placing at')
    return
  }

  const surface = player.surface
  const inventory = player.get_main_inventory()
  if (!inventory) {
    log('[AUTORIO] [ERROR] Cannot access player inventory to place entity')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Cannot access player inventory']
  }

  const entity_prototype = prototypes.entity[params.entity_name]
  if (!entity_prototype || !entity_prototype.items_to_place_this) {
    log('[AUTORIO] [ERROR] Invalid entity name, cannot place')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid entity name']
  }

  const item_name = entity_prototype.items_to_place_this[0]
  if (!item_name) {
    log('[AUTORIO] [ERROR] Invalid entity name, cannot place')
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Invalid entity name']
  }

  const [item_stack] = inventory.find_item_stack(params.entity_name)
  if (!item_stack) {
    log(`[AUTORIO] [ERROR] ${params.entity_name} not found in inventory to place`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Entity not found in inventory']
  }

  const position = { x: params.x, y: params.y }
  const can_place = surface.can_place_entity({
    name: params.entity_name,
    position,
    direction: params.direction as defines.direction,
    force: player.force,
    build_check_type: defines.build_check_type.manual,
  })
  if (!can_place) {
    log(`[AUTORIO] [ERROR] Cannot place ${params.entity_name} at (${params.x},${params.y}): blocked or invalid position`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return [false, 'Cannot place here']
  }

  storage.player_state.task_state = TaskStates.IDLE
  const entity = surface.create_entity({
    name: params.entity_name,
    position,
    direction: params.direction as defines.direction,
    force: player.force,
    raise_built: true,
    player,
  })

  if (entity) {
    item_stack.count = item_stack.count - 1
    push_character_clear(player, entity)
    log(`[AUTORIO] Entity placed at exact position: ${params.entity_name} (${params.x},${params.y})`)
    task_manager.reset_task_state()
    task_manager.next_task()
    return [true, 'Entity placed successfully', entity]
  }
  log(`[AUTORIO] [ERROR] Failed to place entity at (${params.x},${params.y}): ${params.entity_name}`)
  task_manager.reset_task_state()
  task_manager.next_task()
  return [false, 'Failed to place entity']
}

// TODO: Move items between specified entity and player inventory, give the entity name and position as parameters
function state_moving_items(player: LuaPlayer) {
  const parameters = storage.player_state.parameters_move_items

  if (!parameters) {
    log('[AUTORIO] No parameters found when moving items')
    return
  }

  // Item moves use the script inventory API (insert/remove), which ignores player
  // build/reach distance — so the old radius-8 limit was an artificial proxy that
  // made fueling fail "out of reach" whenever the agent had drifted a few tiles
  // after building. Widen it so the just-built machine is still found. (Capped at
  // max_count total, so it tops up the nearest matching machines, not the whole base.)
  const nearby_entities = player.surface.find_entities_filtered({
    position: player.position,
    radius: 32,
    name: parameters.entity_name,
    force: player.force,
  })

  const player_inventory = player.get_main_inventory()
  if (!player_inventory) {
    log('[AUTORIO] [ERROR] Cannot access player inventory to move items')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  let moved_total = 0

  if (parameters.to_entity) {
    const [item_stack, unused_count] = player_inventory.find_item_stack(parameters.item_name)
    if (!item_stack) {
      log(`[AUTORIO] [ERROR] ${parameters.item_name} not found in player inventory to move`)
      task_manager.reset_task_state()
      task_manager.next_task()
      return
    }

    nearby_entities
      .filter(it => it.can_insert({ name: parameters.item_name }))
      .map((entity) => {
        const max_index = entity.get_max_inventory_index()
        const inventories: LuaInventory[] = []
        for (let i = 1; i <= max_index; i++) {
          const inventory = entity.get_inventory(i)
          if (inventory && inventory.can_insert({ name: parameters.item_name })) {
            inventories.push(inventory)
          }
        }

        return inventories
      })
      .flat()
      .forEach((inventory) => {
        if (moved_total >= parameters.max_count) {
          return
        }

        const to_move = math.min(item_stack.count, parameters.max_count - moved_total)
        if (to_move <= 0) {
          return
        }

        log(`[AUTORIO] Moving ${to_move} ${parameters.item_name} to ${inventory.entity_owner?.name} inventory index ${inventory.index}`)
        const moved = inventory.insert({ name: parameters.item_name, count: to_move })
        if (moved > 0) {
          player_inventory.remove({ name: parameters.item_name, count: moved })
          moved_total += moved

          log(`[AUTORIO] Moved ${moved} ${parameters.item_name} to ${inventory.entity_owner?.name} inventory index ${inventory.index}`)
        }
      })
  }
  else {
    nearby_entities
      .map((entity) => {
        const max_index = entity.get_max_inventory_index()
        const inventories: LuaInventory[] = []
        for (let i = 1; i <= max_index; i++) {
          const inventory = entity.get_inventory(i)
          if (!inventory) {
            continue
          }
          inventories.push(inventory)
        }

        return inventories
      })
      .flat()
      .forEach((inventory) => {
        if (moved_total >= parameters.max_count) {
          return
        }

        if (!player_inventory.can_insert({ name: parameters.item_name })) {
          log(`[AUTORIO] Cannot insert ${parameters.item_name} into player inventory, skipping`)
          return
        }

        const removed = inventory.remove({ name: parameters.item_name, count: parameters.max_count - moved_total })
        if (removed <= 0) {
          return
        }

        const inserted = player_inventory.insert({ name: parameters.item_name, count: removed })
        if (inserted < removed) {
          // move back the remaining items
          inventory.insert({ name: parameters.item_name, count: removed - inserted })
          moved_total += inserted
        }
        else {
          moved_total += removed
        }

        log(`[AUTORIO] Moved ${removed} ${parameters.item_name} from ${inventory.entity_owner?.name} inventory index ${inventory.index}`)
      })
  }

  if (moved_total === 0) {
    log(`[AUTORIO] [ERROR] No ${parameters.item_name} moved (target full/empty or out of reach)`)
  }
  else {
    log(`[AUTORIO] Moved a total of ${moved_total} ${parameters.item_name}`)
  }

  task_manager.reset_task_state()
  task_manager.next_task()
}

function check_can_craft(player: LuaPlayer, item_name: string, count: number) {
  const recipe = player.force.recipes[item_name]

  if (!recipe) {
    log(`[AUTORIO] No such recipe: ${item_name}`)
    return false
  }

  const ingredients = recipe.ingredients
  const player_inventory = player.get_main_inventory()

  if (!player_inventory) {
    log('[AUTORIO] Cannot access player inventory, ending CRAFTING task')
    return false
  }

  const not_enough_ingredients: { name: string, amount: number }[] = []

  // TODO check dependencies
  for (const ingredient of ingredients) {
    const item_count = player_inventory.get_item_count(ingredient.name)

    if (item_count < ingredient.amount * count) {
      not_enough_ingredients.push({ name: ingredient.name, amount: ingredient.amount * count - item_count })
    }
  }

  if (not_enough_ingredients.length > 0) {
    // Hand the agent the REAL recipe + exactly what's short, in plain text. LLMs
    // routinely misremember recipes; surfacing the authoritative one on failure
    // means the next attempt can craft/gather the missing inputs instead of
    // guessing again. (serpent.line dumped a Lua table the model parsed poorly.)
    const needs = recipe.ingredients.map(i => `${i.amount * count} ${i.name}`).join(' + ')
    const missing = not_enough_ingredients.map(i => `${i.amount} ${i.name}`).join(', ')
    log(`[AUTORIO] [ERROR] Cannot craft ${count} ${item_name}: needs ${needs}; missing ${missing}. Get the missing item(s) first.`)
    return false
  }

  return true
}

function state_researching(player: LuaPlayer) {
  if (!storage.player_state.parameters_research_technology) {
    log('[AUTORIO] No parameters found when researching')
    return
  }

  const force = player.force
  const tech = force.technologies[storage.player_state.parameters_research_technology.technology_name]

  if (tech.researched) {
    log(`[AUTORIO] Research completed: ${storage.player_state.parameters_research_technology.technology_name}`)
    task_manager.reset_task_state()
    task_manager.next_task()
  }
  else if (force.current_research !== tech) {
    log(`[AUTORIO] Research interrupted: ${storage.player_state.parameters_research_technology.technology_name}`)
    task_manager.reset_task_state()
    task_manager.next_task()
  }
}

function state_walking_direct(player: LuaPlayer) {
  const params = storage.player_state.parameters_walking_direct
  if (!params) {
    log('[AUTORIO] No parameters found when walking directly')
    return
  }

  const target = params.target_position
  if (!target) {
    log('[AUTORIO] No target position, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  // Reached?
  if (((target.x - player.position.x) ** 2 + (target.y - player.position.y) ** 2) < 2) {
    log('[AUTORIO] Reached target, switching to IDLE state')
    player.walking_state = { walking: false, direction: player.walking_state.direction }
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  // Stuck handling: a straight-line walk can't route around trees, so when the
  // character stops advancing (wedged in a forest), MINE the obstacles around it
  // and keep heading for the target — bounded so it fails cleanly if truly walled in.
  const last = params.last_position
  if (last) {
    const moved = (player.position.x - last.x) ** 2 + (player.position.y - last.y) ** 2
    params.stuck_ticks = moved < STUCK_PROGRESS_EPS * STUCK_PROGRESS_EPS ? (params.stuck_ticks ?? 0) + 1 : 0
  }
  params.last_position = { x: player.position.x, y: player.position.y }

  if ((params.stuck_ticks ?? 0) >= STUCK_TICKS) {
    params.stuck_ticks = 0
    params.clears = (params.clears ?? 0) + 1
    if ((params.clears ?? 0) > 40) {
      log('[AUTORIO] [ERROR] Wedged on the direct walk after clearing many obstacles, aborting')
      player.walking_state = { walking: false, direction: player.walking_state.direction }
      task_manager.cancel_all_tasks()
      return
    }
    const cleared = clear_obstacles_near(player)
    if (cleared > 0) {
      log(`[AUTORIO] Direct walk wedged — cleared ${cleared} blocking tree(s)/rock(s)`)
    }
  }

  player.walking_state = { walking: true, direction: get_direction(player.position, target) }
}

function state_attacking(player: LuaPlayer) {
  const parameters = storage.player_state.parameters_attack_nearest_enemy
  if (!parameters) {
    log('[AUTORIO] No parameters found when attacking')
    return
  }

  // (re)acquire the nearest enemy whenever we don't have a valid target yet
  if (!parameters.target || !parameters.target.valid) {
    const enemies = player.surface.find_entities_filtered({
      position: player.position,
      radius: parameters.search_radius,
      force: 'enemy',
    })

    const nearest_entity = get_nearest_entity(player, enemies)
    if (!nearest_entity) {
      log(`[AUTORIO] [ERROR] No enemy found in ${parameters.search_radius}m radius, reverting to IDLE state`)
      player.shooting_state = { state: defines.shooting.not_shooting, position: player.position }
      task_manager.reset_task_state()
      task_manager.next_task()
      return
    }

    parameters.target = nearest_entity
    parameters.ticks_elapsed = 0
  }

  // give up if the target cannot be defeated in time (e.g. no weapon/ammo) so the queue never stalls
  if (parameters.ticks_elapsed >= 600) {
    log('[AUTORIO] [ERROR] Could not defeat the enemy in time, reverting to IDLE state')
    player.shooting_state = { state: defines.shooting.not_shooting, position: player.position }
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }
  parameters.ticks_elapsed += 1

  player.update_selected_entity(parameters.target.position)
  player.shooting_state = {
    state: defines.shooting.shooting_selected,
    position: parameters.target.position,
  }
}

function state_waiting() {
  if (!storage.player_state.parameters_waiting) {
    log('[AUTORIO] No parameters found when waiting')
    return
  }

  if (storage.player_state.parameters_waiting.remaining_ticks <= 0) {
    log('[AUTORIO] Waiting task complete')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  storage.player_state.parameters_waiting.remaining_ticks -= 1
}

// Passive perception: runs every tick (even when IDLE) so the agent is alerted
// to threats while doing nothing. Enemy scan is throttled; health read is cheap.
function update_perception(player: LuaPlayer) {
  const character = player.character
  if (!character) {
    return
  }
  const tick = game.tick
  const perception = storage.perception

  const max_health = character.max_health
  const health = character.health ?? max_health
  const ratio = max_health > 0 ? health / max_health : 1
  if (ratio <= low_health_ratio && !perception.low_health_alerted) {
    perception.low_health_alerted = true
    log(`[AUTORIO] [EVENT] low_health ratio=${math.floor(ratio * 100) / 100}`)
  }
  else if (ratio > low_health_ratio && perception.low_health_alerted) {
    perception.low_health_alerted = false
    log(`[AUTORIO] [EVENT] health_recovered ratio=${math.floor(ratio * 100) / 100}`)
  }

  if (perception.under_attack && tick - perception.last_damage_tick > under_attack_timeout) {
    perception.under_attack = false
    log(`[AUTORIO] [EVENT] attack_ended`)
  }

  if (perception.structures_lost_pending > 0 && tick - perception.last_structure_alert_tick >= structure_alert_interval) {
    log(`[AUTORIO] [EVENT] structure_lost count=${perception.structures_lost_pending}`)
    perception.structures_lost_pending = 0
    perception.last_structure_alert_tick = tick
  }

  if (tick - perception.last_enemy_scan_tick < enemy_scan_interval) {
    return
  }
  perception.last_enemy_scan_tick = tick

  const enemies = player.surface.find_entities_filtered({
    position: player.position,
    radius: enemy_scan_radius,
    force: 'enemy',
    is_military_target: true,
  })
  const count = enemies.length
  const prev = perception.last_enemy_count

  if (count > 0 && prev === 0) {
    const nearest = get_nearest_entity(player, enemies)
    if (nearest) {
      const d = math.floor(distance(nearest.position, player.position))
      log(`[AUTORIO] [EVENT] enemies_spotted count=${count} nearest=${nearest.name} distance=${d}`)
    }
  }
  else if (count === 0 && prev > 0) {
    log(`[AUTORIO] [EVENT] enemies_cleared`)
  }
  perception.last_enemy_count = count
}

let no_player_found = false

script.on_event(defines.events.on_tick, (unused_event) => {
  // Defensive: storage may be empty right after a hot-reload; init is idempotent.
  init_storage()

  if (!storage.setup_complete) {
    setup()
  }

  const player = get_player()
  if (player === undefined || player.character === undefined) {
    if (!no_player_found) {
      log('[AUTORIO] No valid player found')
      no_player_found = true
    }
    return
  }

  update_perception(player)

  if (storage.player_state.task_state === TaskStates.IDLE) {
    return
  }

  if (storage.player_state.task_state === TaskStates.WALKING_TO_ENTITY) {
    state_walking_to_entity(player)
  }
  else if (storage.player_state.task_state === TaskStates.MINING) {
    state_mining(player)
  }
  else if (storage.player_state.task_state === TaskStates.PLACING) {
    state_placing(player)
  }
  else if (storage.player_state.task_state === TaskStates.PLACING_AT) {
    state_placing_at(player)
  }
  else if (storage.player_state.task_state === TaskStates.MOVING_ITEMS) {
    state_moving_items(player)
  }
  else if (storage.player_state.task_state === TaskStates.RESEARCHING) {
    state_researching(player)
  }
  else if (storage.player_state.task_state === TaskStates.WALKING_DIRECT) {
    state_walking_direct(player)
  }
  else if (storage.player_state.task_state === TaskStates.ATTACKING) {
    state_attacking(player)
  }
  else if (storage.player_state.task_state === TaskStates.WAITING) {
    state_waiting()
  }
})

script.on_event(defines.events.on_player_crafted_item, (event: OnPlayerCraftedItemEvent) => {
  log(`[AUTORIO] Player ${get_player(event.player_index)?.name ?? 'unknown'} crafted item: ${event.item_stack.name}`)

  if (!storage.player_state.parameters_craft_item) {
    log('[AUTORIO] No parameters found when item crafted')
    return
  }

  if (storage.player_state.task_state !== TaskStates.CRAFTING) {
    return
  }

  storage.player_state.parameters_craft_item.crafted = storage.player_state.parameters_craft_item.crafted + 1
  log(`[AUTORIO] Crafted 1 ${storage.player_state.parameters_craft_item.item_name}, remaining: ${storage.player_state.parameters_craft_item.count - storage.player_state.parameters_craft_item.crafted}`)

  if (storage.player_state.parameters_craft_item.crafted >= storage.player_state.parameters_craft_item.count) {
    log('[AUTORIO] Crafting task complete')
    task_manager.reset_task_state()
    task_manager.next_task()
  }
})

log('[AUTORIO] Mod loaded 1')

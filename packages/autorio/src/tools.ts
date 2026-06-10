import type { MapPosition } from 'factorio:runtime'
import { get_nearest_entity } from './utils/entity'
import { get_inventory_items } from './utils/inventory'
import { distance } from './utils/math'
import { get_player } from './utils/player'

// Reverse map: a defines.direction int -> human-friendly string (for the LLM's scan).
// Covers the 8 cardinal/diagonal directions placed entities use; rails' in-between
// 16-way values fall back to 'north'.
function name_from_direction(dir: number): string {
  switch (dir) {
    case defines.direction.east:
      return 'east'
    case defines.direction.south:
      return 'south'
    case defines.direction.west:
      return 'west'
    case defines.direction.northeast:
      return 'northeast'
    case defines.direction.southeast:
      return 'southeast'
    case defines.direction.southwest:
      return 'southwest'
    case defines.direction.northwest:
      return 'northwest'
    default:
      return 'north'
  }
}

// Reverse map: a defines.entity_status int -> string. The statuses the agent cares
// about for automation; anything else -> 'other', nil -> 'n/a'.
function status_name(status: number | undefined): string {
  if (status === undefined) {
    return 'n/a'
  }
  switch (status) {
    case defines.entity_status.working:
      return 'working'
    case defines.entity_status.normal:
      return 'normal'
    case defines.entity_status.no_power:
      return 'no_power'
    case defines.entity_status.low_power:
      return 'low_power'
    case defines.entity_status.no_fuel:
      return 'no_fuel'
    case defines.entity_status.item_ingredient_shortage:
      return 'item_ingredient_shortage'
    case defines.entity_status.fluid_ingredient_shortage:
      return 'fluid_ingredient_shortage'
    case defines.entity_status.full_output:
      return 'full_output'
    case defines.entity_status.not_plugged_in_electric_network:
      return 'not_plugged_in_electric_network'
    case defines.entity_status.no_minable_resources:
      return 'no_minable_resources'
    case defines.entity_status.disabled_by_script:
      return 'disabled_by_script'
    default:
      return 'other'
  }
}

export function create_tools_remote_interface() {
  remote.add_interface('autorio_tools', {
    get_inventory_items: (player_id: number) => {
      rcon.print(serpent.block(get_inventory_items(player_id)))
      return true
    },
    get_recipe: (item_name: string, player_id: number) => {
      const player = get_player(player_id)
      if (!player) {
        rcon.print('no player found')
        return false
      }

      const recipe = player.force.recipes[item_name]
      if (!recipe) {
        rcon.print('no such recipe')
        return false
      }

      if (!recipe.enabled) {
        rcon.print('recipe locked')
        return false
      }

      const ingredients = recipe.ingredients.map((ingredient) => {
        return {
          name: ingredient.name,
          count: ingredient.amount,
        }
      })

      rcon.print(serpent.block(ingredients))
      return true
    },
    get_player_status: (player_id: number) => {
      const player = get_player(player_id)
      if (!player) {
        rcon.print('no player found')
        return false
      }

      const character = player.character
      const max_health = character?.max_health ?? 0
      const health = character?.health
      const health_ratio = (character && max_health > 0 && health !== undefined)
        ? math.floor((health / max_health) * 100) / 100
        : undefined

      const enemies = player.surface.find_entities_filtered({
        position: player.position,
        radius: 30,
        force: 'enemy',
        is_military_target: true,
      })
      let nearest_enemy: { name: string, position: MapPosition, distance: number } | undefined
      if (enemies.length > 0) {
        const n = get_nearest_entity(player, enemies)
        if (n) {
          nearest_enemy = { name: n.name, position: n.position, distance: math.floor(distance(n.position, player.position)) }
        }
      }

      const weapons: string[] = []
      const ammo: { name: string, count: number }[] = []
      if (character) {
        const guns = character.get_inventory(defines.inventory.character_guns)
        if (guns) {
          guns.get_contents().forEach(item => weapons.push(item.name))
        }
        const ammo_inventory = character.get_inventory(defines.inventory.character_ammo)
        if (ammo_inventory) {
          ammo_inventory.get_contents().forEach(item => ammo.push({ name: item.name, count: item.count }))
        }
      }

      rcon.print(serpent.block({
        tick: game.tick,
        name: player.name,
        position: player.position,
        alive: character !== undefined,
        health,
        max_health,
        health_ratio,
        under_attack: storage.perception.under_attack,
        ticks_since_last_damage: storage.perception.last_damage_tick > 0 ? game.tick - storage.perception.last_damage_tick : undefined,
        nearby_enemy_count: enemies.length,
        nearest_enemy,
        weapons,
        ammo,
        task_state: storage.player_state.task_state,
        vehicle: player.vehicle?.name ?? 'None',
      }))
      return true
    },
    // Structured spatial scan for the learning agent: nearby entities (with
    // position/direction/status) + aggregated resource patches, as JSON. Immediate
    // (no task, never settles). Bounded so an ore field can't blow the RCON line.
    scan_area: (radius: number) => {
      const player = get_player()
      if (!player) {
        rcon.print('{}')
        return false
      }
      const r = math.min(radius > 0 ? radius : 32, 64)
      const surface = player.surface

      const entities: { name: string, type: string, x: number, y: number, direction: string, status: string }[] = []
      let n = 0
      for (const e of surface.find_entities_filtered({ position: player.position, radius: r })) {
        if (e.name === 'character') {
          continue
        }
        if (n >= 200) {
          break
        }
        n += 1
        entities.push({
          name: e.name,
          type: e.type,
          x: math.floor(e.position.x * 10) / 10,
          y: math.floor(e.position.y * 10) / 10,
          direction: name_from_direction(e.direction),
          status: status_name(e.status),
        })
      }

      const resources: Record<string, { count: number, x: number, y: number }> = {}
      for (const res of surface.find_entities_filtered({ position: player.position, radius: r, type: 'resource' })) {
        const cur = resources[res.name]
        if (cur !== undefined) {
          cur.count += 1
        }
        else {
          resources[res.name] = { count: 1, x: math.floor(res.position.x), y: math.floor(res.position.y) }
        }
      }

      rcon.print(helpers.table_to_json({ tick: game.tick, origin: player.position, radius: r, entities, resources }))
      return true
    },
    // Authoritative lookup for the learning agent so it stops GUESSING recipes /
    // machine mechanics. Returns JSON { name, recipe?, entity? } with camelCase
    // keys matching the agent's RecipeInfo/EntityInfo types. A missing key means
    // "no recipe" / "not a placeable entity" (the agent reads that as null).
    describe: (name: string) => {
      const result: Record<string, unknown> = { name }

      // Recipe (force-specific so `enabled` reflects what's actually unlocked).
      const player = get_player()
      if (player !== undefined) {
        const recipe = player.force.recipes[name]
        if (recipe !== undefined) {
          result.recipe = {
            name,
            ingredients: recipe.ingredients.map(i => ({ name: i.name, amount: i.amount })),
            products: recipe.products.map(p => ({ name: p.name, amount: p.amount ?? 1 })),
            enabled: recipe.enabled,
            category: recipe.category,
          }
        }
      }

      // Placeable-entity mechanics (energy source, footprint, what a drill mines).
      const proto = prototypes.entity[name]
      if (proto !== undefined) {
        let energy_source = 'none'
        if (proto.electric_energy_source_prototype) {
          energy_source = 'electric'
        }
        else if (proto.burner_prototype) {
          energy_source = 'burner'
        }
        else if (proto.heat_energy_source_prototype) {
          energy_source = 'heat'
        }
        else if (proto.fluid_energy_source_prototype) {
          energy_source = 'fluid'
        }

        const box = proto.collision_box
        const entity: Record<string, unknown> = {
          name,
          type: proto.type,
          energySource: energy_source,
          needsFuel: energy_source === 'burner',
          size: {
            w: math.ceil(box.right_bottom.x - box.left_top.x),
            h: math.ceil(box.right_bottom.y - box.left_top.y),
          },
        }
        // Guard type-specific props — accessing them on the wrong prototype can error.
        if (proto.type === 'mining-drill') {
          entity.miningSpeed = proto.mining_speed
          entity.resourceCategories = proto.resource_categories ? Object.keys(proto.resource_categories) : []
        }
        if (proto.type === 'furnace' || proto.type === 'assembling-machine') {
          entity.craftingSpeed = proto.get_crafting_speed()
        }
        result.entity = entity
      }

      rcon.print(helpers.table_to_json(result))
      return true
    },
  })
}

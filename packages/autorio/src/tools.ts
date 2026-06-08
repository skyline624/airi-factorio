import type { MapPosition } from 'factorio:runtime'
import { get_nearest_entity } from './utils/entity'
import { get_inventory_items } from './utils/inventory'
import { distance } from './utils/math'
import { get_player } from './utils/player'

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
  })
}

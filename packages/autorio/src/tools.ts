import { get_inventory_items } from './utils/inventory'
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
  })
}

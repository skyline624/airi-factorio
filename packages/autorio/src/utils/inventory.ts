import { get_player } from './player'

export interface InventoryItem {
  name: string
  count: number
}

export function get_inventory_items(player_id: number): InventoryItem[] {
  log(`[AUTORIO] Getting inventory items for player: ${player_id}`)

  const player = get_player(player_id)
  if (!player) {
    log(`[AUTORIO] No player found for id ${player_id}`)
    return []
  }

  const main_inventory = player.get_main_inventory()
  if (!main_inventory) {
    return []
  }

  return main_inventory.get_contents().map(({ name, count }) => ({ name, count }))
}

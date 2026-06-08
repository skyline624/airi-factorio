import type { LuaEntity, LuaPlayer } from 'factorio:runtime'

export function get_nearest_entity(player: LuaPlayer, entities: LuaEntity[]): LuaEntity | null {
  let min_distance = math.huge
  let nearest_entity: LuaEntity | null = null

  if (entities.length === 0) {
    return null
  }

  for (const entity of entities) {
    const distance = (entity.position.x - player.position.x) ** 2 + (entity.position.y - player.position.y) ** 2
    if (distance < min_distance) {
      min_distance = distance
      nearest_entity = entity
    }
  }

  return nearest_entity
}

import type { LuaPlayer, PlayerIndex } from 'factorio:runtime'

// game.connected_players is a sequential list that is NOT indexed by player_index,
// so the previous `connected_players[player_id - 1]` math was error-prone and only
// happened to work because TSTL shifts 0-based TS indices to 1-based Lua.
// game.get_player looks up by the stable player_index instead. Default to the main
// player (index 1) the autorio bot controls.
export function get_player(player_index: number = 1): LuaPlayer | undefined {
  return game.get_player(player_index as PlayerIndex)
}

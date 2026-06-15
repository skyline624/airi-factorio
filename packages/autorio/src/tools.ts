import type { LuaEntity, LuaForce, LuaPlayer, LuaSurface, MapPosition } from 'factorio:runtime'
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
// about for automation; anything else -> 'other', nil -> 'n/a'. Exported so the
// placement handler can report a just-placed entity's status (B1 structured result).
export function status_name(status: number | undefined): string {
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
    // A steam-engine/turbine with no steam reaching it (boiler not connected / not heating).
    case defines.entity_status.no_input_fluid:
      return 'no_input_fluid'
    case defines.entity_status.full_output:
      return 'full_output'
    // A drill that MINES fine but has nowhere to put the ore (no furnace/belt/chest at
    // its output). It is correctly placed — the fix is to add an output, NOT relocate it.
    // Was previously mapped to 'other', which made the critic order pointless relocations.
    case defines.entity_status.waiting_for_space_in_destination:
      return 'waiting_for_space_in_destination'
    // A machine waiting for its INPUT items (e.g. a furnace/assembler with no ore yet).
    case defines.entity_status.waiting_for_source_items:
      return 'waiting_for_source_items'
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

// --- Deterministic steam-power assembly (build_steam_power) ---------------------
// The fluid alignment of a pump -> boiler -> steam-engine chain is a fixed mechanism
// with a single correct solution, NOT a spatial layout choice — exactly the kind of
// thing an LLM cannot reliably emit as orchestration code (it knows the data via the
// map's pump_spots, but mis-sequences the multi-step build). So we build it in Lua and
// let the ENGINE confirm every fluid hookup via PipeConnection.target — no hardcoded
// geometry, just place-and-verify.

const WATER_TILE_NAMES = ['water', 'deepwater', 'water-shallow', 'water-mud', 'deepwater-green', 'water-green']
const POLE_ITEM_NAMES = ['small-electric-pole', 'medium-electric-pole', 'big-electric-pole', 'substation']

// Candidate offshore-pump placements for a water tile (wx,wy = its integer tile coords).
// The pump does NOT sit on the water: it sits on the adjacent LAND tile and FACES into the
// water (this is the rule the in-game green placement preview enforces). Return the 4 land
// neighbours with the direction that points toward the water.
function pump_candidates(wx: number, wy: number): Array<{ x: number, y: number, dname: string, dir: defines.direction }> {
  return [
    { x: wx + 0.5, y: wy - 0.5, dname: 'south', dir: defines.direction.south }, // pump NORTH of water, faces south
    { x: wx + 0.5, y: wy + 1.5, dname: 'north', dir: defines.direction.north }, // pump SOUTH of water, faces north
    { x: wx - 0.5, y: wy + 0.5, dname: 'east', dir: defines.direction.east }, //   pump WEST of water, faces east
    { x: wx + 1.5, y: wy + 0.5, dname: 'west', dir: defines.direction.west }, //   pump EAST of water, faces west
  ]
}

// Absolute target tile of the FIRST connection whose flow_direction is one of `flows`.
// EXACT match (no input-output folding): a boiler's water ports are 'input-output' and
// its steam port is 'output', so ['output'] returns the STEAM target, not the water one
// (folding them was why the engine got placed on the water side and never received steam).
function connection_target_of(entity: LuaEntity, flows: string[]): MapPosition | undefined {
  const fb = entity.fluidbox
  for (let i = 1; i <= fb.length; i++) {
    for (const c of fb.get_pipe_connections(i)) {
      for (const f of flows) {
        if (c.flow_direction === f) {
          return c.target_position
        }
      }
    }
  }
  return undefined
}

// True when any connection whose flow_direction is one of `flows` is ACTUALLY linked to a
// neighbour fluidbox — the game's own confirmation the hookup took. Check this on the
// JUST-PLACED entity's intake (['input','input-output']); checking the upstream's 'output'
// gave a false positive because the boiler's already-linked water port is 'input-output'.
function has_linked_connection(entity: LuaEntity, flows: string[]): boolean {
  const fb = entity.fluidbox
  for (let i = 1; i <= fb.length; i++) {
    for (const c of fb.get_pipe_connections(i)) {
      if (c.target !== undefined) {
        for (const f of flows) {
          if (c.flow_direction === f) {
            return true
          }
        }
      }
    }
  }
  return false
}

// Clear organic obstacles (trees/rocks only — never ore or built entities) around a
// tile so a cramped/forested shore doesn't block the boiler/engine placement.
function clear_growth_around(surface: LuaSurface, center: MapPosition, radius: number) {
  for (const e of surface.find_entities_filtered({ position: center, radius, type: ['tree', 'simple-entity'] })) {
    if (e.valid) {
      e.destroy()
    }
  }
}

// If the character ended up inside a freshly-placed entity's collision box, shove it
// onto the nearest free tile so the player is never boxed in by the build.
function push_clear_of(player: LuaPlayer, surface: LuaSurface, entity: LuaEntity | undefined) {
  const character = player.character
  if (character === undefined || entity === undefined || !entity.valid) {
    return
  }
  const bb = entity.bounding_box
  const cp = character.position
  if (cp.x >= bb.left_top.x && cp.x <= bb.right_bottom.x && cp.y >= bb.left_top.y && cp.y <= bb.right_bottom.y) {
    const free = surface.find_non_colliding_position('character', cp, 8, 0.25)
    if (free !== undefined) {
      character.teleport(free)
    }
  }
}

// Place `name` near `target` and keep it only once the ENGINE reports `upstream`'s
// `flow` connection as linked (place-and-verify). Tries near offsets + all 4 rotations;
// trial placements use raise_built:false and destroy() (no death events) so failed tries
// don't spam the mod's perception handlers. Returns the kept entity or undefined.
function place_connected(surface: LuaSurface, force: LuaForce, player: LuaPlayer, name: string, target: MapPosition, verify_flows: string[]): LuaEntity | undefined {
  const offsets = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2, 2.5, -2.5]
  const dirs = [defines.direction.north, defines.direction.east, defines.direction.south, defines.direction.west]
  for (const dy of offsets) {
    for (const dx of offsets) {
      const position = { x: target.x + dx, y: target.y + dy }
      for (const dir of dirs) {
        if (!surface.can_place_entity({ name, position, direction: dir, force, build_check_type: defines.build_check_type.manual })) {
          continue
        }
        const e = surface.create_entity({ name, position, direction: dir, force, raise_built: false, player })
        if (e === undefined) {
          continue
        }
        // Keep this placement only if the NEWLY-PLACED entity's intake actually linked up.
        if (has_linked_connection(e, verify_flows)) {
          return e
        }
        e.destroy()
      }
    }
  }
  return undefined
}

// Total minable resource amount in a drill's mining area — so the agent can tell a
// DEPLETED drill (move on) from one that's merely mis-seated/off-patch (re-place it) or
// fine (leave it). Without this, 'no_minable_resources' alone reads as "broken" and the
// agent needlessly rebuilds drills that still sit on plenty of ore.
function drill_ore_under(surface: LuaSurface, drill: LuaEntity): number {
  const radius = drill.prototype.mining_drill_radius ?? 1
  const p = drill.position
  const area = { left_top: { x: p.x - radius, y: p.y - radius }, right_bottom: { x: p.x + radius, y: p.y + radius } }
  let total = 0
  for (const r of surface.find_entities_filtered({ area, type: 'resource' })) {
    total = total + r.amount
  }
  return math.floor(total)
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
      const r = math.min(radius > 0 ? radius : 32, 128)
      const surface = player.surface

      const entities: { name: string, type: string, x: number, y: number, direction: string, status: string, mining?: string, oreUnder?: number }[] = []
      let n = 0
      for (const e of surface.find_entities_filtered({ position: player.position, radius: r })) {
        if (e.name === 'character') {
          continue
        }
        if (n >= 200) {
          break
        }
        n += 1
        const rec: { name: string, type: string, x: number, y: number, direction: string, status: string, mining?: string, oreUnder?: number } = {
          name: e.name,
          type: e.type,
          x: math.floor(e.position.x * 10) / 10,
          y: math.floor(e.position.y * 10) / 10,
          direction: name_from_direction(e.direction),
          status: status_name(e.status),
        }
        if (e.type === 'mining-drill') {
          const mt = e.mining_target
          rec.mining = mt !== undefined ? mt.name : 'nothing'
          rec.oreUnder = drill_ore_under(surface, e)
        }
        entities.push(rec)
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
    // Surface-wide census of the player-force's PRODUCING machines + their status,
    // in the same shape as scan_area. The critic uses this to judge "is the factory
    // running?" regardless of where the player wandered — a player-centred scan_area
    // misses the build whenever the agent walked off (e.g. to mine coal) before the
    // run ended, which read as a false "machines missing / misplaced".
    scan_factory: () => {
      const player = get_player()
      if (player === undefined) {
        rcon.print('{}')
        return false
      }
      const surface = player.surface
      const producer_types = ['mining-drill', 'furnace', 'assembling-machine', 'lab', 'boiler', 'generator', 'pumpjack', 'chemical-plant', 'oil-refinery', 'rocket-silo']
      const entities: { name: string, type: string, x: number, y: number, direction: string, status: string, mining?: string, oreUnder?: number }[] = []
      let n = 0
      for (const e of surface.find_entities_filtered({ force: player.force, type: producer_types })) {
        if (n >= 100) {
          break
        }
        n += 1
        const rec: { name: string, type: string, x: number, y: number, direction: string, status: string, mining?: string, oreUnder?: number } = {
          name: e.name,
          type: e.type,
          x: math.floor(e.position.x * 10) / 10,
          y: math.floor(e.position.y * 10) / 10,
          direction: name_from_direction(e.direction),
          status: status_name(e.status),
        }
        // For drills, report the resource actually being mined (catch a drill on the WRONG
        // resource) AND the ore left in its mining area (tell DEPLETED from mis-seated).
        if (e.type === 'mining-drill') {
          const mt = e.mining_target
          rec.mining = mt !== undefined ? mt.name : 'nothing'
          rec.oreUnder = drill_ore_under(surface, e)
        }
        entities.push(rec)
      }
      rcon.print(helpers.table_to_json({ tick: game.tick, origin: player.position, radius: -1, entities, resources: {} }))
      return true
    },
    // ASCII minimap of a square area centred on (cx,cy). An LLM reads adjacency, alignment
    // and machine footprints FAR better from a 2D grid than from a flat coordinate list.
    // Read-only, no player required (works headless). 1 char = 1 tile; world_x = origin.x +
    // col, world_y = origin.y + row (x grows right, y grows down). Returns rows as an array.
    render_map: (cx: number, cy: number, radius: number) => {
      const surface = game.surfaces[1]
      const r = math.min(radius > 0 ? radius : 16, 40)
      const ox = math.floor(cx) - r
      const oy = math.floor(cy) - r
      const w = r * 2 + 1
      const h = r * 2 + 1
      const overlay: Record<string, string> = {}
      const put = (x: number, y: number, ch: string) => {
        const col = math.floor(x) - ox
        const row = math.floor(y) - oy
        if (col >= 0 && col < w && row >= 0 && row < h) {
          overlay[`${col}_${row}`] = ch
        }
      }
      const res_char: Record<string, string> = { 'iron-ore': 'i', 'copper-ore': 'c', 'coal': 'k', 'stone': 's', 'crude-oil': 'o', 'uranium-ore': 'u' }
      const area = { left_top: { x: ox, y: oy }, right_bottom: { x: ox + w, y: oy + h } }
      for (const e of surface.find_entities_filtered({ area, type: 'resource' })) {
        put(e.position.x, e.position.y, res_char[e.name] ?? 'r')
      }
      for (const e of surface.find_entities_filtered({ area, type: ['tree', 'simple-entity', 'cliff'] })) {
        put(e.position.x, e.position.y, e.type === 'cliff' ? '#' : (e.type === 'tree' ? 'T' : '*'))
      }
      const belt_arrow: Record<string, string> = { north: '^', east: '>', south: 'v', west: '<' }
      for (const e of surface.find_entities_filtered({ area, force: game.forces.player })) {
        const ty = e.type
        let ch: string | undefined
        if (ty === 'mining-drill') { ch = 'D' }
        else if (ty === 'furnace') { ch = 'F' }
        else if (ty === 'lab') { ch = 'L' }
        else if (ty === 'boiler') { ch = 'B' }
        else if (ty === 'generator') { ch = 'E' }
        else if (ty === 'offshore-pump') { ch = 'P' }
        else if (ty === 'assembling-machine') { ch = 'A' }
        else if (ty === 'transport-belt') { ch = belt_arrow[name_from_direction(e.direction)] ?? 'b' }
        else if (ty === 'inserter') { ch = 'n' }
        else if (ty === 'electric-pole') { ch = '+' }
        else if (ty === 'pipe' || ty === 'pipe-to-ground') { ch = '=' }
        else if (ty === 'container' || ty === 'logistic-container') { ch = 'H' }
        if (ch !== undefined) {
          const bb = e.bounding_box
          const x0 = math.floor(bb.left_top.x)
          const y0 = math.floor(bb.left_top.y)
          const x1 = math.ceil(bb.right_bottom.x) - 1
          const y1 = math.ceil(bb.right_bottom.y) - 1
          for (let yy = y0; yy <= y1; yy++) {
            for (let xx = x0; xx <= x1; xx++) {
              put(xx, yy, ch)
            }
          }
        }
      }
      const player = game.connected_players[0]
      if (player !== undefined && player.character !== undefined) {
        put(player.position.x, player.position.y, '@')
      }
      // Each mining-drill's OUTPUT (drop) tile — the spatial info the model otherwise has to
      // infer from the drill's facing. Mark it 'X' (only where no entity already sits) so the
      // model SEES where to put a furnace/belt/chest to receive the ore, and return the tiles.
      // Once a furnace is correctly placed over it, the 'F' wins and the 'X' disappears.
      // The drop tile is usually ON the ore patch (the drill sits on ore), so 'X' must OVERRIDE
      // the ore/terrain char to be visible — but NOT a machine already there (a furnace covering
      // it = success, keep 'F'). So skip only when a built-entity char already occupies the tile.
      const structure_chars: Record<string, boolean> = { D: true, F: true, L: true, B: true, E: true, P: true, A: true, n: true, '+': true, '=': true, H: true, '^': true, '>': true, v: true, '<': true, b: true, '@': true }
      const drill_outputs: Array<{ x: number, y: number, furnace_at?: { x: number, y: number } }> = []
      const dfo_force = game.forces.player
      for (const e of surface.find_entities_filtered({ area, type: 'mining-drill', force: game.forces.player })) {
        const dp = e.drop_position
        const dtx = math.floor(dp.x)
        const dty = math.floor(dp.y)
        const dcol = dtx - ox
        const drow = dty - oy
        if (dcol >= 0 && dcol < w && drow >= 0 && drow < h) {
          const occupied = overlay[`${dcol}_${drow}`]
          if (occupied === undefined || !structure_chars[occupied]) {
            overlay[`${dcol}_${drow}`] = 'X'
          }
          // Ready-to-use placeAt coord for a 2x2 furnace COVERING this output tile (placeAt
          // centres a 2x2, so (cx,cy) covers tiles (cx-1,cy-1)..(cx,cy)). Try the 4 centres
          // whose footprint covers the drop tile; keep the first that's actually placeable
          // (i.e. doesn't collide with the drill). Mirrors pump_spots — the model placeAt's it.
          let furnace_at: { x: number, y: number } | undefined
          for (const c of [{ x: dtx + 1, y: dty + 1 }, { x: dtx, y: dty + 1 }, { x: dtx + 1, y: dty }, { x: dtx, y: dty }]) {
            if (surface.can_place_entity({ name: 'stone-furnace', position: { x: c.x, y: c.y }, force: dfo_force, build_check_type: defines.build_check_type.manual })) {
              furnace_at = c
              break
            }
          }
          drill_outputs.push({ x: dtx, y: dty, furnace_at })
        }
      }
      // Valid offshore-pump placements — the non-visual constraint the model cannot read off
      // the grid. For each water tile, test can_place_entity in the 4 directions; mark a valid
      // spot 'O' and return the EXACT { x, y, direction } so the model placeAt's it directly.
      const pump_spots: Array<{ x: number, y: number, direction: string }> = []
      const pump_force = game.forces.player
      for (let row = 0; row < h && pump_spots.length < 6; row++) {
        for (let col = 0; col < w && pump_spots.length < 6; col++) {
          const tx = ox + col
          const ty = oy + row
          const wt = surface.get_tile(tx, ty)
          if (!(wt.valid && wt.collides_with('water_tile'))) {
            continue
          }
          // The pump sits on the LAND tile beside the water, FACING it (the green-preview rule),
          // so pump_spots advertises the land position + direction the player could place by hand.
          for (const cand of pump_candidates(tx, ty)) {
            if (surface.can_place_entity({ name: 'offshore-pump', position: { x: cand.x, y: cand.y }, direction: cand.dir, force: pump_force, build_check_type: defines.build_check_type.manual })) {
              pump_spots.push({ x: cand.x, y: cand.y, direction: cand.dname })
              const pcol = math.floor(cand.x) - ox
              const prow = math.floor(cand.y) - oy
              if (pcol >= 0 && pcol < w && prow >= 0 && prow < h) {
                overlay[`${pcol}_${prow}`] = 'O'
              }
              break
            }
          }
        }
      }
      const pad_right = (str: string, n: number) => {
        let out = str
        while (out.length < n) {
          out = `${out} `
        }
        return out
      }
      const pad_left = (str: string, n: number) => {
        let out = str
        while (out.length < n) {
          out = ` ${out}`
        }
        return out
      }
      const lw = math.max((`${oy}`).length, (`${oy + h - 1}`).length)
      const lines: string[] = []
      // Top x-ruler: the EXACT x coordinate every 5 columns, aligned under the grid so the
      // model reads real numbers instead of counting cells.
      let ruler = pad_right('', lw + 1)
      for (let col = 0; col < w; col = col + 5) {
        ruler = ruler + pad_right(`${ox + col}`, 5)
      }
      lines[0] = ruler
      for (let row = 0; row < h; row++) {
        let s = ''
        for (let col = 0; col < w; col++) {
          const o = overlay[`${col}_${row}`]
          if (o !== undefined) {
            s = s + o
          }
          else {
            const t = surface.get_tile(ox + col, oy + row)
            s = s + ((t.valid && t.collides_with('water_tile')) ? '~' : '.')
          }
        }
        // Each row prefixed with its EXACT y coordinate.
        lines[row + 1] = `${pad_left(`${oy + row}`, lw)} ${s}`
      }
      const legend = 'ground=. water=~ cliff=# tree=T rock=* | ore: i=iron c=copper k=coal s=stone | D=drill F=furnace L=lab B=boiler E=steam-engine P=offshore-pump A=assembler n=inserter +=pole ==pipe H=chest | O=valid offshore-pump spot (see pump_spots) | X=a drill OUTPUT tile (place a furnace/belt/chest to COVER it; see drill_outputs) | belt ^>v< points where items move | @=you'
      rcon.print(helpers.table_to_json({ ok: true, origin: { x: ox, y: oy }, w, h, note: 'Coords are EXACT: the top line lists x every 5 columns; each row starts with its y. The cell at column c / row r is world (origin.x+c, origin.y+r). Pass these REAL numbers to placeAt - never (0,0). pump_spots lists ready-to-use {x,y,direction} for an offshore-pump (placeAt them directly). drill_outputs lists each drill OUTPUT tile (X) with furnace_at = the ready placeAt coord for a stone-furnace covering it (placeAt it directly, like pump_spots).', legend, grid: lines, pump_spots, drill_outputs }))
      return true
    },
    // Locate the NEAREST thing of a given name well beyond scan range — the fix for
    // the agent wandering off / never finding water. `scan_area` is player-local and
    // capped; this searches a wide radius and returns just {name,x,y,distance} (or {}
    // if none). Handles WATER, which is a tile (never returned by entity scans) — so
    // the agent can actually locate a shore to place an offshore-pump.
    find_nearest: (name: string) => {
      const player = get_player()
      if (player === undefined) {
        rcon.print('{}')
        return false
      }
      const surface = player.surface
      const pp = player.position
      let bx = 0
      let by = 0
      let bd = -1
      if (name === 'water' || name === 'deepwater') {
        const tiles = surface.find_tiles_filtered({ position: pp, radius: 400, name: ['water', 'deepwater', 'water-shallow', 'water-mud', 'deepwater-green', 'water-green'] })
        for (const t of tiles) {
          const dx = t.position.x - pp.x
          const dy = t.position.y - pp.y
          const d = dx * dx + dy * dy
          if (bd < 0 || d < bd) {
            bd = d
            bx = t.position.x
            by = t.position.y
          }
        }
      }
      else {
        for (const e of surface.find_entities_filtered({ name, position: pp, radius: 400 })) {
          const dx = e.position.x - pp.x
          const dy = e.position.y - pp.y
          const d = dx * dx + dy * dy
          if (bd < 0 || d < bd) {
            bd = d
            bx = math.floor(e.position.x * 10) / 10
            by = math.floor(e.position.y * 10) / 10
          }
        }
      }
      if (bd < 0) {
        rcon.print('{}')
      }
      else {
        rcon.print(helpers.table_to_json({ name, x: bx, y: by, distance: math.floor(math.sqrt(bd)) }))
      }
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
    // RESEARCH op: the full production chain for an item, read straight from the
    // game's recipe graph (so the agent doesn't need the tech tree in its prompt or
    // its memory). Returns { raw: {resource: amount to MINE}, steps: [intermediates
    // to make, leaves-first, with craft|smelting category + enabled], locked: [steps
    // whose recipe isn't researched yet] }. Recursion is depth-capped + cycle-guarded.
    craft_plan: (item: string, count: number = 1) => {
      const force = game.forces.player
      const raw: Record<string, number> = {}
      const amounts: Record<string, number> = {}
      const categories: Record<string, string> = {}
      const enabled: Record<string, boolean> = {}
      const order: string[] = []
      const ordered: Record<string, boolean> = {}
      const in_progress: Record<string, boolean> = {}

      function expand(name: string, need: number, depth: number): void {
        const recipe = force.recipes[name]
        if (recipe === undefined || depth > 8 || in_progress[name]) {
          raw[name] = (raw[name] ?? 0) + need
          return
        }
        let per = 1
        for (const p of recipe.products) {
          if (p.name === name && p.amount !== undefined && p.amount > 0) {
            per = p.amount
          }
        }
        const crafts = math.ceil(need / per)
        in_progress[name] = true
        for (const ing of recipe.ingredients) {
          expand(ing.name, ing.amount * crafts, depth + 1)
        }
        in_progress[name] = false
        amounts[name] = (amounts[name] ?? 0) + need
        categories[name] = recipe.category
        enabled[name] = recipe.enabled
        if (!ordered[name]) {
          ordered[name] = true
          order.push(name)
        }
      }
      expand(item, count, 0)

      const steps: { name: string, amount: number, category: string, enabled: boolean }[] = []
      const locked: string[] = []
      for (const n of order) {
        steps.push({ name: n, amount: math.ceil(amounts[n] ?? 0), category: categories[n] ?? 'crafting', enabled: enabled[n] ?? true })
        if (!(enabled[n] ?? true)) {
          locked.push(n)
        }
      }
      rcon.print(helpers.table_to_json({ item, count, raw, steps, locked }))
      return true
    },
    // RESEARCH op: which technology unlocks an item's recipe (+ its science cost and
    // prerequisites), so the agent knows what to research to reach a locked item.
    tech_for: (item: string) => {
      const force = game.forces.player
      const recipe = force.recipes[item]
      if (recipe !== undefined && recipe.enabled) {
        rcon.print(helpers.table_to_json({ item, unlocked: true }))
        return true
      }
      for (const [tech_name, tech] of Object.entries(prototypes.technology)) {
        for (const eff of tech.effects ?? []) {
          if (eff.type === 'unlock-recipe' && eff.recipe === item) {
            const ft = force.technologies[tech_name]
            const science = tech.research_unit_ingredients.map(i => ({ name: i.name, amount: i.amount }))
            const prerequisites: string[] = []
            for (const pname of Object.keys(tech.prerequisites)) {
              prerequisites.push(pname)
            }
            rcon.print(helpers.table_to_json({ item, unlocked: false, tech: tech_name, researched: ft !== undefined ? ft.researched : false, science, prerequisites }))
            return true
          }
        }
      }
      rcon.print(helpers.table_to_json({ item, unlocked: false }))
      return true
    },
    // RESEARCH op: reverse lookup — what an item is FOR (the recipes that consume it),
    // so the agent can reason about an item's utility without a glossary in its prompt.
    used_in: (item: string) => {
      const products: string[] = []
      for (const [recipe_name, recipe] of game.forces.player.recipes) {
        if (products.length >= 40) {
          break
        }
        for (const ing of recipe.ingredients) {
          if (ing.name === item) {
            products.push(recipe_name)
            break
          }
        }
      }
      rcon.print(helpers.table_to_json({ item, usedIn: products }))
      return true
    },
    // RESEARCH: the force's cumulative item production/consumption counters. This is
    // ground truth the inventory can't give: inventory counts what the player HOLDS,
    // these count what was MADE — so the critic can verify "produce N plates" even if
    // they were consumed, and (with machine statuses) judge whether a chain actually
    // produced. NOTE: hand-mining/crafting also counts here; pair with scan_factory.
    production_stats: () => {
      const player = get_player()
      const surface = player !== undefined ? player.surface : game.surfaces[1]
      const stats = game.forces.player.get_item_production_statistics(surface)
      const produced: Record<string, number> = {}
      for (const [item, count] of Object.entries(stats.input_counts)) {
        produced[item] = count
      }
      const consumed: Record<string, number> = {}
      for (const [item, count] of Object.entries(stats.output_counts)) {
        consumed[item] = count
      }
      rcon.print(helpers.table_to_json({ produced, consumed }))
      return true
    },
    // Set the recipe on the nearest assembling-machine to the player. An assembler does
    // NOTHING until it has a recipe (and power — assemblers are electric). This is what lets
    // the agent AUTOMATE intermediates (gears, circuits) instead of hand-crafting them.
    set_recipe: (recipe_name: string) => {
      const player = get_player()
      if (player === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no player' }))
        return false
      }
      const recipe = player.force.recipes[recipe_name]
      if (recipe === undefined || !recipe.enabled) {
        rcon.print(helpers.table_to_json({ ok: false, error: `recipe '${recipe_name}' is unknown or not researched yet` }))
        return false
      }
      const asms = player.surface.find_entities_filtered({ position: player.position, radius: 20, type: 'assembling-machine' })
      if (asms.length === 0) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no assembling-machine within 20 tiles (place one first)' }))
        return false
      }
      const asm = get_nearest_entity(player, asms)
      if (asm === undefined || asm === null) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no assembling-machine found' }))
        return false
      }
      asm.set_recipe(recipe_name)
      rcon.print(helpers.table_to_json({ ok: true, recipe: recipe_name, x: math.floor(asm.position.x * 10) / 10, y: math.floor(asm.position.y * 10) / 10 }))
      return true
    },
    // Deterministic ONE-CALL steam power: places offshore-pump -> boiler -> steam-engine,
    // fluid-aligned and verified by the engine itself, fuels the boiler with coal, and wires
    // an electric pole if you have one. Needs you NEAR water (walk to a shore first) and the
    // items in your inventory (1 offshore-pump, 1 boiler, 1 steam-engine, some coal). Returns
    // JSON { ok, error?, pump, boiler, engine, coal, pole, note } with placed coords+statuses.
    build_steam_power: () => {
      const player = get_player()
      if (player === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no player' }))
        return false
      }
      const surface = player.surface
      const force = player.force
      const inv = player.get_main_inventory()
      if (inv === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no inventory' }))
        return false
      }

      // 1) Inventory requirements — fail with an explicit shopping list, not a silent dud.
      const missing: string[] = []
      if (inv.get_item_count('offshore-pump') < 1) {
        missing.push('offshore-pump x1')
      }
      if (inv.get_item_count('boiler') < 1) {
        missing.push('boiler x1')
      }
      if (inv.get_item_count('steam-engine') < 1) {
        missing.push('steam-engine x1')
      }
      if (inv.get_item_count('coal') < 1) {
        missing.push('coal (fuel)')
      }
      if (missing.length > 0) {
        rcon.print(helpers.table_to_json({ ok: false, error: `missing items: ${missing.join(', ')}. Craft/get them first.` }))
        return false
      }

      // 2) A valid offshore-pump spot: nearest water tiles to the player, first placeable
      //    (tile,direction) wins. Mirrors render_map's pump_spots (build_check_type.script).
      const pp = player.position
      const tiles = surface.find_tiles_filtered({ position: pp, radius: 40, name: WATER_TILE_NAMES })
      if (tiles.length === 0) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no water within 40 tiles — walk to a water shore first (use findNearest("water") then walkTo)' }))
        return false
      }
      tiles.sort((a, b) => distance(pp, a.position) - distance(pp, b.position))
      let pump: LuaEntity | undefined
      for (const t of tiles) {
        // build_check_type.manual = the in-game GREEN placement preview: the pump sits on
        // the LAND tile beside the water, facing into it. (script was laxer and accepted a
        // BACKWARDS pump centred ON the water whose output fell on water, so nothing connected.)
        for (const cand of pump_candidates(math.floor(t.position.x), math.floor(t.position.y))) {
          if (surface.can_place_entity({ name: 'offshore-pump', position: { x: cand.x, y: cand.y }, direction: cand.dir, force, build_check_type: defines.build_check_type.manual })) {
            pump = surface.create_entity({ name: 'offshore-pump', position: { x: cand.x, y: cand.y }, direction: cand.dir, force, raise_built: true, player })
            if (pump !== undefined) {
              break
            }
          }
        }
        if (pump !== undefined) {
          break
        }
      }
      if (pump === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'found water but no placeable offshore-pump spot nearby — try a cleaner/straighter shore' }))
        return false
      }
      inv.remove({ name: 'offshore-pump', count: 1 })
      push_clear_of(player, surface, pump)

      // 3) Boiler onto the pump's water output (clear trees first); verify the boiler's
      //    water intake (input / input-output) actually linked.
      const pout = connection_target_of(pump, ['output'])
      if (pout === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'placed the pump but could not read its water output connection' }))
        return false
      }
      clear_growth_around(surface, pout, 4)
      const boiler = place_connected(surface, force, player, 'boiler', pout, ['input', 'input-output'])
      if (boiler === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: `placed the pump at (${math.floor(pump.position.x)},${math.floor(pump.position.y)}) but no boiler position connected to its water output (terrain too cramped) — try another shore`, pump: { x: math.floor(pump.position.x), y: math.floor(pump.position.y) } }))
        return false
      }
      inv.remove({ name: 'boiler', count: 1 })

      // 4) Steam-engine onto the boiler's STEAM output (strict 'output', so not the water
      //    side); verify the engine's steam intake actually linked.
      const sout = connection_target_of(boiler, ['output'])
      let engine: LuaEntity | undefined
      if (sout !== undefined) {
        clear_growth_around(surface, sout, 4)
        engine = place_connected(surface, force, player, 'steam-engine', sout, ['input', 'input-output'])
      }
      if (engine !== undefined) {
        inv.remove({ name: 'steam-engine', count: 1 })
      }

      // 5) Fuel the boiler so it actually heats (the chain is dead without coal).
      const want_coal = math.min(inv.get_item_count('coal'), 25)
      const inserted = want_coal > 0 ? boiler.insert({ name: 'coal', count: want_coal }) : 0
      if (inserted > 0) {
        inv.remove({ name: 'coal', count: inserted })
      }

      // 6) Wire an electric pole next to the engine if the player has one (optional —
      //    without it the chain still generates but isn't connected to a network).
      let pole_placed = false
      if (engine !== undefined) {
        for (const pole_name of POLE_ITEM_NAMES) {
          if (inv.get_item_count(pole_name) < 1) {
            continue
          }
          const ppos = surface.find_non_colliding_position(pole_name, engine.position, 6, 0.5)
          if (ppos !== undefined) {
            const pole = surface.create_entity({ name: pole_name, position: ppos, force, raise_built: true, player })
            if (pole !== undefined) {
              inv.remove({ name: pole_name, count: 1 })
              pole_placed = true
              break
            }
          }
        }
      }

      push_clear_of(player, surface, boiler)
      push_clear_of(player, surface, engine)

      const pump_info = { x: math.floor(pump.position.x), y: math.floor(pump.position.y), status: status_name(pump.status) }
      const boiler_info = { x: math.floor(boiler.position.x), y: math.floor(boiler.position.y), status: status_name(boiler.status) }
      const engine_info = engine !== undefined ? { x: math.floor(engine.position.x), y: math.floor(engine.position.y), status: status_name(engine.status) } : undefined
      const note = engine === undefined
        ? 'pump + fueled boiler built, but no steam-engine spot connected to the boiler steam output — clear space behind the boiler and place a steam-engine there.'
        : (pole_placed ? 'pump -> boiler -> steam-engine built, fluid-connected and fueled, with an electric pole.' : 'pump -> boiler -> steam-engine built, fluid-connected and fueled. No electric pole in inventory — add a pole next to the engine to power a network.')
      log(`[AUTORIO] build_steam_power: ${note}`)
      rcon.print(helpers.table_to_json({ ok: engine !== undefined, pump: pump_info, boiler: boiler_info, engine: engine_info, coal: inserted, pole: pole_placed, note }))
      return true
    },
  })
}

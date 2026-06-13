import type { BoundingBox, MapPosition } from 'factorio:runtime'
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
      const entities: { name: string, type: string, x: number, y: number, direction: string, status: string, mining?: string }[] = []
      let n = 0
      for (const e of surface.find_entities_filtered({ force: player.force, type: producer_types })) {
        if (n >= 100) {
          break
        }
        n += 1
        const rec: { name: string, type: string, x: number, y: number, direction: string, status: string, mining?: string } = {
          name: e.name,
          type: e.type,
          x: math.floor(e.position.x * 10) / 10,
          y: math.floor(e.position.y * 10) / 10,
          direction: name_from_direction(e.direction),
          status: status_name(e.status),
        }
        // For drills, report the resource actually being mined so the critic can catch
        // a drill seated on the WRONG resource (e.g. stone when the objective wanted iron).
        if (e.type === 'mining-drill') {
          const mt = e.mining_target
          rec.mining = mt !== undefined ? mt.name : 'nothing'
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
      const legend = 'ground=. water=~ cliff=# tree=T rock=* | ore: i=iron c=copper k=coal s=stone | D=drill F=furnace L=lab B=boiler E=steam-engine P=offshore-pump A=assembler n=inserter +=pole ==pipe H=chest | belt ^>v< points where items move | @=you'
      rcon.print(helpers.table_to_json({ ok: true, origin: { x: ox, y: oy }, w, h, note: 'Coords are EXACT: the top line lists x every 5 columns; each row starts with its y. The cell at column c / row r is world (origin.x+c, origin.y+r). Pass these REAL numbers to placeAt - never (0,0).', legend, grid: lines }))
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
  })
}

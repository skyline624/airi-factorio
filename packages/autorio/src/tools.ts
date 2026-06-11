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
    // PLACEMENT PRIMITIVE: drop a correctly-oriented inserter between two machines so
    // the LLM doesn't have to compute tile coords + facing (its weak spot — it kept
    // placing belts on blocked tiles and forgot the "arms"). Deterministic: place near
    // the midpoint, then try all 4 facings and keep the one whose REAL pickup/drop
    // position (read from the game) best lands pickup on `from` and drop on `to`.
    // inserter_name defaults to burner-inserter (works with NO power, unlike 'inserter').
    place_inserter_between: (from_name: string, to_name: string, inserter_name: string = 'burner-inserter') => {
      const player = get_player()
      const inv = player !== undefined ? player.get_main_inventory() : undefined
      if (player === undefined || inv === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no player/inventory' }))
        return false
      }
      const surface = player.surface
      const pp = player.position

      let use_name = inserter_name
      if (inv.get_item_count(use_name) === 0) {
        if (inv.get_item_count('burner-inserter') > 0) {
          use_name = 'burner-inserter'
        }
        else if (inv.get_item_count('inserter') > 0) {
          use_name = 'inserter'
        }
        else {
          rcon.print(helpers.table_to_json({ ok: false, error: `no ${inserter_name} (or any inserter) in inventory` }))
          return false
        }
      }

      function nearest_of(name: string) {
        const filter = prototypes.entity[name] !== undefined
          ? { name, position: pp, radius: 32 }
          : { type: name, position: pp, radius: 32 }
        const candidates = surface.find_entities_filtered(filter)
        if (candidates.length === 0) {
          return undefined
        }
        let best = candidates[0]
        let bd = (best.position.x - pp.x) ** 2 + (best.position.y - pp.y) ** 2
        for (const e of candidates) {
          const d = (e.position.x - pp.x) ** 2 + (e.position.y - pp.y) ** 2
          if (d < bd) {
            bd = d
            best = e
          }
        }
        return best
      }

      const from = nearest_of(from_name)
      const to = nearest_of(to_name)
      if (from === undefined || to === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'from/to entity not found within 32 tiles' }))
        return false
      }

      // An inserter only reaches 1 tile, so it must sit ADJACENT to `from` (not at the
      // midpoint). Anchor it just outside `from` on the cardinal side toward `to`.
      const ddx = to.position.x - from.position.x
      const ddy = to.position.y - from.position.y
      const ux = math.abs(ddx) >= math.abs(ddy) ? (ddx >= 0 ? 1 : -1) : 0
      const uy = ux === 0 ? (ddy >= 0 ? 1 : -1) : 0
      const anchor = { x: from.position.x + ux * 1.5, y: from.position.y + uy * 1.5 }
      const pos = surface.find_non_colliding_position(use_name, anchor, 2, 0.5)
      if (pos === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no free tile next to from to place an inserter' }))
        return false
      }

      const ent = surface.create_entity({ name: use_name, position: pos, force: player.force, raise_built: true, player })
      if (ent === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'create_entity failed' }))
        return false
      }

      // Orient using the game's OWN pickup/drop geometry: pickup on `from`, drop toward `to`.
      const fb = from.bounding_box
      function inside_from(px: number, py: number): boolean {
        return px >= fb.left_top.x && px <= fb.right_bottom.x && py >= fb.left_top.y && py <= fb.right_bottom.y
      }
      const dirs = [defines.direction.north, defines.direction.east, defines.direction.south, defines.direction.west]
      let best_dir = ent.direction
      let best_score = -1e18
      for (const d of dirs) {
        ent.direction = d
        const pick = ent.pickup_position
        const drop = ent.drop_position
        // strongly reward pickup landing INSIDE `from`; then reward drop being near `to`.
        const d_drop = (drop.x - to.position.x) ** 2 + (drop.y - to.position.y) ** 2
        const score = (inside_from(pick.x, pick.y) ? 1000 : 0) - d_drop
        if (score > best_score) {
          best_score = score
          best_dir = d
        }
      }
      ent.direction = best_dir

      // VERIFY the connection actually works; if not, don't leave a dead inserter (or
      // consume the item) — destroy it and report cleanly so the agent can adapt.
      if (!inside_from(ent.pickup_position.x, ent.pickup_position.y)) {
        ent.destroy()
        rcon.print(helpers.table_to_json({ ok: false, error: `could not orient an inserter to pick from ${from_name} (is ${to_name} adjacent on a free side?)` }))
        return false
      }

      inv.remove({ name: use_name, count: 1 })
      log(`[AUTORIO] Placed ${use_name} taking from ${from_name} toward ${to_name} at (${pos.x},${pos.y})`)
      rcon.print(helpers.table_to_json({ ok: true, inserter: use_name, x: math.floor(pos.x * 10) / 10, y: math.floor(pos.y * 10) / 10, direction: best_dir }))
      return true
    },
    // PLACEMENT PRIMITIVE: lay a straight L-shaped line of aligned belts from (start)
    // to (end), each belt oriented toward the flow. Belts MUST sit on exact tile centres
    // to connect, so — unlike the inserter — we cannot nudge them off a blocked tile.
    // Instead we place every free tile, RE-ORIENT any belt already there (no wasted item),
    // and report the blocked tiles so the LLM can mine the obstacle or reroute. The path
    // is a simple L: horizontal leg first, then vertical.
    place_belt_line: (start_x: number, start_y: number, end_x: number, end_y: number, belt_name: string = 'transport-belt') => {
      const player = get_player()
      const inv = player !== undefined ? player.get_main_inventory() : undefined
      if (player === undefined || inv === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no player/inventory' }))
        return false
      }
      const surface = player.surface

      let use_name = belt_name
      if (inv.get_item_count(use_name) === 0) {
        if (inv.get_item_count('transport-belt') > 0) {
          use_name = 'transport-belt'
        }
        else {
          rcon.print(helpers.table_to_json({ ok: false, error: `no ${belt_name} (or transport-belt) in inventory` }))
          return false
        }
      }

      function snap(v: number): number {
        return math.floor(v) + 0.5
      }
      const sx = snap(start_x)
      const sy = snap(start_y)
      const ex = snap(end_x)
      const ey = snap(end_y)

      // Ordered tile path: walk the horizontal leg, then the vertical leg (L-shape).
      const path: Array<{ x: number, y: number }> = [{ x: sx, y: sy }]
      let cx = sx
      let cy = sy
      while (cx !== ex) {
        cx += cx < ex ? 1 : -1
        path.push({ x: cx, y: cy })
      }
      while (cy !== ey) {
        cy += cy < ey ? 1 : -1
        path.push({ x: cx, y: cy })
      }

      function dir_to(ax: number, ay: number, bx: number, by: number): defines.direction {
        if (bx > ax) {
          return defines.direction.east
        }
        if (bx < ax) {
          return defines.direction.west
        }
        if (by > ay) {
          return defines.direction.south
        }
        return defines.direction.north
      }

      let placed = 0
      let reused = 0
      const blocked: Array<{ x: number, y: number }> = []

      for (let i = 0; i < path.length; i++) {
        const tile = path[i]
        // Each belt points toward the NEXT tile; the last tile keeps the previous heading.
        const dir = i < path.length - 1
          ? dir_to(tile.x, tile.y, path[i + 1].x, path[i + 1].y)
          : (path.length > 1 ? dir_to(path[i - 1].x, path[i - 1].y, tile.x, tile.y) : defines.direction.east)

        // A belt already on this tile → just re-orient it (don't fail, don't waste an item).
        const existing = surface.find_entities_filtered({ position: tile, radius: 0.1, type: 'transport-belt' })
        if (existing.length > 0) {
          existing[0].direction = dir
          reused += 1
          continue
        }

        if (inv.get_item_count(use_name) === 0) {
          blocked.push(tile) // out of belts — the rest of the line is unfulfilled
          continue
        }

        const can = surface.can_place_entity({
          name: use_name,
          position: tile,
          direction: dir,
          force: player.force,
          build_check_type: defines.build_check_type.manual,
        })
        if (!can) {
          blocked.push(tile)
          continue
        }

        const ent = surface.create_entity({ name: use_name, position: tile, direction: dir, force: player.force, raise_built: true, player })
        if (ent === undefined) {
          blocked.push(tile)
          continue
        }
        inv.remove({ name: use_name, count: 1 })
        placed += 1
      }

      const ok = blocked.length === 0 && placed + reused > 0
      log(`[AUTORIO] place_belt_line ${use_name}: placed=${placed} reused=${reused} blocked=${blocked.length}`)
      rcon.print(helpers.table_to_json({ ok, belt: use_name, placed, reused, blocked }))
      return ok
    },
    // PLACEMENT PRIMITIVE: place a mining drill on the nearest patch of a SPECIFIC resource.
    // placeEntity's auto-snap grabs the nearest resource of ANY type, so a drill meant for
    // iron lands on a closer stone patch and the furnace behind it ends up making bricks.
    // This snaps onto the resource the agent NAMED and VERIFIES the drill actually mines it
    // (mining_target resolves immediately, unlike drop_target which needs fuel) — else it
    // destroys the drill and fails cleanly instead of leaving a wrong-resource drill.
    place_drill_on: (resource_name: string, drill_name: string = 'burner-mining-drill') => {
      const player = get_player()
      const inv = player !== undefined ? player.get_main_inventory() : undefined
      if (player === undefined || inv === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no player/inventory' }))
        return false
      }
      // Guard against an unknown resource name (find_entities_filtered{name=...} throws on one).
      if (prototypes.entity[resource_name] === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: `unknown resource '${resource_name}'` }))
        return false
      }
      const surface = player.surface
      const pp = player.position

      let use_name = drill_name
      if (inv.get_item_count(use_name) === 0) {
        if (inv.get_item_count('burner-mining-drill') > 0) {
          use_name = 'burner-mining-drill'
        }
        else if (inv.get_item_count('electric-mining-drill') > 0) {
          use_name = 'electric-mining-drill'
        }
        else {
          rcon.print(helpers.table_to_json({ ok: false, error: `no ${drill_name} (or any mining drill) in inventory` }))
          return false
        }
      }

      const resources = surface.find_entities_filtered({ name: resource_name, position: pp, radius: 200 })
      if (resources.length === 0) {
        rcon.print(helpers.table_to_json({ ok: false, error: `no ${resource_name} within 200 tiles (walk closer first)` }))
        return false
      }
      let ore = resources[0]
      let bd = (ore.position.x - pp.x) ** 2 + (ore.position.y - pp.y) ** 2
      for (const r of resources) {
        const d = (r.position.x - pp.x) ** 2 + (r.position.y - pp.y) ** 2
        if (d < bd) {
          bd = d
          ore = r
        }
      }

      // Snap onto the patch: search outward FROM the ore tile so the drill covers it.
      const pos = surface.find_non_colliding_position(use_name, ore.position, 6, 0.5)
      if (pos === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: `no free tile on the ${resource_name} patch to seat a ${use_name}` }))
        return false
      }

      const ent = surface.create_entity({ name: use_name, position: pos, force: player.force, raise_built: true, player })
      if (ent === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'create_entity failed' }))
        return false
      }

      // VERIFY the drill physically covers the intended resource. mining_target is NOT
      // populated synchronously at create_entity (it needs a tick, exactly like drop_target),
      // so we can't read it here — instead check the resources under the drill's footprint.
      // If the named resource isn't there, the snap landed on the wrong patch: destroy + fail.
      const bb = ent.bounding_box
      const area = {
        left_top: { x: bb.left_top.x - 0.4, y: bb.left_top.y - 0.4 },
        right_bottom: { x: bb.right_bottom.x + 0.4, y: bb.right_bottom.y + 0.4 },
      }
      let on_target = false
      for (const r of surface.find_entities_filtered({ area, type: 'resource' })) {
        if (r.name === resource_name) {
          on_target = true
          break
        }
      }
      if (!on_target) {
        ent.destroy()
        rcon.print(helpers.table_to_json({ ok: false, error: `could not seat the drill ON ${resource_name} (no ${resource_name} under it); walk onto the ${resource_name} patch and retry` }))
        return false
      }

      inv.remove({ name: use_name, count: 1 })
      log(`[AUTORIO] Placed ${use_name} mining ${resource_name} at (${pos.x},${pos.y})`)
      rcon.print(helpers.table_to_json({ ok: true, drill: use_name, x: math.floor(pos.x * 10) / 10, y: math.floor(pos.y * 10) / 10, mining: resource_name }))
      return true
    },
    // PLACEMENT PRIMITIVE: put a furnace ON a drill's output tile so the drill feeds it
    // hands-free (automation rung 2). The exact 2x2-furnace-over-the-drop-tile geometry is
    // where the LLM fails — it hardcodes coords that miss or collide, leaving misplaced
    // furnaces that then block the correct spot. This enumerates the covering centres,
    // is IDEMPOTENT (a furnace already covering the drop = success), and RECLAIMS the
    // agent's own misplaced furnaces / dropped items blocking the spot instead of failing.
    place_furnace_at_drill: (furnace_name: string = 'stone-furnace') => {
      const player = get_player()
      const inv = player !== undefined ? player.get_main_inventory() : undefined
      if (player === undefined || inv === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no player/inventory' }))
        return false
      }
      const surface = player.surface

      let use_name = furnace_name
      if (inv.get_item_count(use_name) === 0) {
        if (inv.get_item_count('stone-furnace') > 0) {
          use_name = 'stone-furnace'
        }
        else if (inv.get_item_count('steel-furnace') > 0) {
          use_name = 'steel-furnace'
        }
        else {
          rcon.print(helpers.table_to_json({ ok: false, error: `no ${furnace_name} (or any furnace) in inventory` }))
          return false
        }
      }

      const drills = surface.find_entities_filtered({ position: player.position, radius: 48, type: 'mining-drill' })
      if (drills.length === 0) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no mining-drill within 48 tiles (place a drill first)' }))
        return false
      }
      const drill = get_nearest_entity(player, drills)
      if (drill === undefined || drill === null) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'no mining-drill within 48 tiles (place a drill first)' }))
        return false
      }
      const drop = drill.drop_position
      const dc = drill.position
      // The drill feeds whatever occupies the drop TILE (not the exact drop point). Test
      // coverage at the tile CENTRE — a furnace's collision box is inset, so the exact
      // drop point can sit just outside it even when the furnace correctly covers the tile.
      const dtx = math.floor(drop.x) + 0.5
      const dty = math.floor(drop.y) + 0.5

      function covers(box: BoundingBox, px: number, py: number): boolean {
        return px >= box.left_top.x && px <= box.right_bottom.x && py >= box.left_top.y && py <= box.right_bottom.y
      }

      // Idempotent: a furnace already covering the drop tile means the feed is set.
      for (const f of surface.find_entities_filtered({ position: drop, radius: 1.5, type: 'furnace' })) {
        if (covers(f.bounding_box, dtx, dty)) {
          rcon.print(helpers.table_to_json({ ok: true, furnace: f.name, x: math.floor(f.position.x * 10) / 10, y: math.floor(f.position.y * 10) / 10, note: 'already on the drill output' }))
          return true
        }
      }

      // Candidate 2x2 furnace centres whose footprint covers the drop tile.
      const candidates: Array<{ x: number, y: number }> = []
      for (const cx of [math.floor(drop.x), math.ceil(drop.x)]) {
        for (const cy of [math.floor(drop.y), math.ceil(drop.y)]) {
          if (math.abs(drop.x - cx) >= 1 || math.abs(drop.y - cy) >= 1) {
            continue
          }
          candidates.push({ x: cx, y: cy })
        }
      }

      function best_placeable(): { x: number, y: number } | undefined {
        let chosen: { x: number, y: number } | undefined
        let best_dist = -1
        for (const c of candidates) {
          if (!surface.can_place_entity({ name: use_name, position: c, force: player!.force, build_check_type: defines.build_check_type.manual })) {
            continue
          }
          // Furthest covering centre from the drill so the furnace extends away from it.
          const dist = (c.x - dc.x) ** 2 + (c.y - dc.y) ** 2
          if (dist > best_dist) {
            best_dist = dist
            chosen = c
          }
        }
        return chosen
      }

      let chosen = best_placeable()
      let reclaimed = 0

      // Blocked: reclaim the agent's own MISplaced furnaces (none covers the drop, checked
      // above) + dropped items near the spot, then retry. mine() returns their contents too.
      if (chosen === undefined) {
        for (const f of surface.find_entities_filtered({ position: drop, radius: 2.5, type: 'furnace' })) {
          if (!f.mine({ inventory: inv, force: true, raise_destroyed: true })) {
            f.destroy()
          }
          reclaimed += 1
        }
        for (const g of surface.find_entities_filtered({ position: drop, radius: 2, name: 'item-on-ground' })) {
          g.destroy()
        }
        chosen = best_placeable()
      }

      if (chosen === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'could not seat a furnace on the drill output tile (still blocked after clearing)' }))
        return false
      }

      const ent = surface.create_entity({ name: use_name, position: chosen, force: player.force, raise_built: true, player })
      if (ent === undefined) {
        rcon.print(helpers.table_to_json({ ok: false, error: 'create_entity failed' }))
        return false
      }
      if (!covers(ent.bounding_box, dtx, dty)) {
        ent.destroy()
        rcon.print(helpers.table_to_json({ ok: false, error: 'placed furnace did not cover the drill output' }))
        return false
      }

      inv.remove({ name: use_name, count: 1 })
      log(`[AUTORIO] Placed ${use_name} on the output of drill at (${dc.x},${dc.y}); reclaimed ${reclaimed} misplaced furnace(s)`)
      rcon.print(helpers.table_to_json({ ok: true, furnace: use_name, x: math.floor(ent.position.x * 10) / 10, y: math.floor(ent.position.y * 10) / 10, reclaimed }))
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

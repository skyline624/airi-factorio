// Shared types for the Voyager-inspired learning subsystem.
// See packages/agent/docs/learning-architecture.md for the overall design.

/** A compact snapshot of the game world, used by the critic (diff) and skills. */
export interface GameState {
  tick: number
  position?: { x: number, y: number }
  health?: number
  maxHealth?: number
  /** item name -> count in the player's main inventory */
  inventory: Record<string, number>
  /** entity name -> count of player-force entities within ~200 tiles */
  entities: Record<string, number>
  /** name of the technology currently being researched, if any */
  currentResearch?: string
  /** how many technologies are fully researched */
  researchedCount?: number
}

/** Result of a single `ops.*` action (one in-game operation). */
export interface OpResult {
  ok: boolean
  error?: string
  data?: unknown
}

/** Outcome of awaiting the in-game settle signal for one operation. */
export interface SettleResult {
  result: 'completed' | 'error' | 'timeout' | 'cancelled'
  detail?: string
  /** Structured per-op payload the mod printed before completion (e.g. a placed entity's tile + status). */
  data?: Record<string, unknown>
}

/** The critic's verdict on whether an objective was achieved. */
export interface Verdict {
  reasoning?: string
  success: boolean
  critique: string
}

/**
 * A machine-verifiable success criterion the CURRICULUM attaches to each objective, so the
 * critic is fully DETERMINISTIC — no LLM judgement, no round-trip. Evaluated against the
 * before/after state diff + production counters (see `evaluateSuccessCheck`). This is the
 * FLE-style move: a factory objective's success IS measurable (an item gained, a machine
 * producing, an entity built, a tech researched), so we don't ask an LLM to guess.
 */
export interface SuccessCheck {
  /** how completion is proven from state: 'acquire' (item gained in inventory/production), 'produce' (force production counter for the item rises — the throughput signal that a machine actually WORKS), 'build' (a new entity exists), 'research' (a technology completes), 'status' (a named machine's post-run status matches `want` — e.g. steam-engine 'working' — read from the scan, used by the deterministic roadmap when a build check alone would PASS on a built-but-not-running machine). */
  kind: 'acquire' | 'produce' | 'build' | 'research' | 'status'
  /** acquire/produce: the Factorio item name, e.g. 'iron-plate'. */
  item?: string
  /** build/status: the Factorio entity name, e.g. 'stone-furnace' / 'steam-engine'. */
  entity?: string
  /** required amount gained/produced/built (default 1). */
  count?: number
  /** status: the desired machine status string (e.g. 'working', 'no_power', 'no_fuel'). PASS when at least one named entity has this status in the post-run scan. */
  want?: string
}

/** A learned skill: LLM-generated code plus metadata. (Consumed from step 4 on.) */
export interface Skill {
  name: string
  description: string
  code: string
  objective: string
  uses: number
  createdAt: number
}

/** One entity from a spatial scan (positions/directions/status, for layout reasoning). */
export interface ScanEntity {
  name: string
  type: string
  x: number
  y: number
  /** 'north' | 'east' | 'south' | 'west' | diagonals */
  direction: string
  /** 'working' | 'no_power' | 'no_fuel' | 'item_ingredient_shortage' | 'full_output' | 'n/a' | … */
  status: string
  /** mining drills only: the resource actually being mined ('iron-ore', 'stone', …) or 'nothing'. Lets you catch a drill seated on the WRONG resource. */
  mining?: string
  /** mining drills only: total ore left in the drill's mining area. 0 = depleted (move on); a high number with status 'no_minable_resources' = the drill is mis-seated/off-patch, re-place it rather than rebuild. */
  oreUnder?: number
  /** crafting machines only (assembler/furnace/rocket-silo): the posed recipe, or 'none' (a crafting machine with no recipe set does nothing). Lets you read "who produces what" in one scan without an N×getEntity round-trip. */
  recipe?: string
}

/**
 * Deep per-entity detail from `ops.getEntity(at)` — an FLE-style rich entity, to DIAGNOSE one
 * machine after `scan` flags a non-'working' status. Heavier than a scan row (recipe, machine
 * inventories, fluid link state), so it's fetched on demand, one entity per call.
 */
export interface EntityDetail {
  name: string
  type: string
  x: number
  y: number
  direction: string
  status: string
  /** crafting machines (assembler/furnace/chemical-plant/refinery/silo): the posed recipe, or 'none' (nothing set → it does nothing). */
  recipe?: string
  /** items waiting in the input/source slots. */
  input?: { name: string, count: number }[]
  /** items sitting in the output slots — a full output means downstream isn't pulling. */
  output?: { name: string, count: number }[]
  /** fuel slot contents (burner machines): empty here while status is no_fuel → feed it coal. */
  fuel?: { name: string, count: number }[]
  /** inserter only: where it picks up — read its facing off pickup vs drop. */
  pickup?: { x: number, y: number }
  /** inserter or mining-drill: the drop tile (drill = where ore lands; put a furnace/belt/chest there). */
  drop?: { x: number, y: number }
  /** transport belts only: the input tile (items enter) + output tile (items leave), derived from the belt's facing, and the items on each lane (left/right). Lets you read what a belt carries and chain "the output of belt A feeds the input of belt B". */
  belt?: { input: { x: number, y: number }, output: { x: number, y: number }, left: { name: string, count: number }[], right: { name: string, count: number }[] }
  /** mining drills only: the resource actually mined, or 'nothing'. */
  mining?: string
  /** mining drills only: ore left in the mining area (0 = depleted). */
  oreUnder?: number
  /** fluid handlers (boiler/engine/pump/refinery/chemical-plant/pipe): each fluidbox's held fluid + per-connection link state. `linked:false` = the fluid hookup did NOT take → reroute the pipe. `fluid:undefined` = the box is empty (e.g. an empty intake with status no_input_fluid). */
  fluids?: { index: number, fluid?: { name: string, amount: number }, connections: { flow: string, linked: boolean }[] }[]
  /** present when status is an item-ingredient shortage — exactly which item is short and by how much. */
  missingIngredients?: string[]
}

/** Result of `ops.scan(radius)`: a structured local map for spatial reasoning + automation checks. */
export interface ScanResult {
  origin?: { x: number, y: number }
  radius?: number
  entities: ScanEntity[]
  /** resource name -> aggregated patch { count, x, y } */
  resources: Record<string, { count: number, x: number, y: number }>
}

/** Authoritative recipe lookup from `ops.getRecipe` (real game data, not a guess). */
export interface RecipeInfo {
  name: string
  /** what you must hold to craft it */
  ingredients: { name: string, amount: number }[]
  /** what crafting it yields */
  products: { name: string, amount: number }[]
  /** true if the recipe is unlocked for the player's force */
  enabled: boolean
  category: string
}

/** Placeable-entity mechanics lookup from `ops.describeEntity` (real prototype data). */
export interface EntityInfo {
  name: string
  /** 'mining-drill' | 'furnace' | 'transport-belt' | 'inserter' | 'assembling-machine' | … */
  type: string
  /** 'burner' (needs fuel) | 'electric' (needs power) | 'heat' | 'fluid' | 'none' */
  energySource: string
  /** true for burner machines — they must be loaded with a fuel like coal */
  needsFuel: boolean
  /** tile footprint, for adjacency / not overlapping when placing */
  size: { w: number, h: number }
  /** mining drills only: how fast it mines */
  miningSpeed?: number
  /** mining drills only: which resource categories it can mine (sit it ON a matching resource) */
  resourceCategories?: string[]
  /** furnaces / assemblers only: crafting speed */
  craftingSpeed?: number
}

/** Result of `ops.findNearest`: the nearest matching entity/resource/water tile + how far. */
export interface NearestResult {
  name: string
  x: number
  y: number
  distance: number
}

/** Full production chain from `ops.craftPlan`, read off the game's recipe graph. */
export interface CraftPlan {
  item: string
  count: number
  /** raw resources to MINE/gather: name -> total amount. */
  raw: Record<string, number>
  /** intermediates to make, leaves-first. category 'crafting' = hand-craft; 'smelting' = needs a furnace. */
  steps: { name: string, amount: number, category: string, enabled: boolean }[]
  /** steps whose recipe isn't researched yet — research these (see `techFor`) first. */
  locked: string[]
}

/** Tech-unlock info from `ops.techFor`: what (if anything) you must research to make an item. */
export interface TechInfo {
  item: string
  unlocked: boolean
  tech?: string
  researched?: boolean
  science?: { name: string, amount: number }[]
  prerequisites?: string[]
}

/** Result of `ops.buildSteamPower()`: the deterministic pump->boiler->engine build. */
export interface SteamPowerResult {
  /** true only when the full chain (incl. a connected steam-engine) was built. */
  ok: boolean
  /** present on failure (e.g. not near water, missing items, terrain too cramped). */
  error?: string
  pump?: { x: number, y: number, status?: string }
  boiler?: { x: number, y: number, status?: string }
  engine?: { x: number, y: number, status?: string }
  /** units of coal loaded into the boiler. */
  coal?: number
  /** whether an electric pole was wired next to the engine. */
  pole?: boolean
  /** whether the engine is CONNECTED to a network (a pole was placed). If false, the engine produces steam but stays not_plugged_in — get a pole (`ensure('small-electric-pole')`) then `connectPowerTo(...)`. */
  powered?: boolean
  note?: string
}

export interface MapView {
  origin: { x: number, y: number }
  w: number
  h: number
  note: string
  legend: string
  /** Rows of the ASCII grid: row 0 is the x ruler; every other row starts with its EXACT y. */
  grid: string[]
  /** Ready-to-use offshore-pump placements (the non-visual water-edge validity, computed by the mod). placeAt one directly. */
  pump_spots?: Array<{ x: number, y: number, direction: string }>
  /** Each mining-drill's OUTPUT (drop) tile, marked 'X' on the grid (place a furnace/belt/chest to COVER it). `furnace_at` is the ready, can-place-verified placeAt coord for a 2x2 stone-furnace covering it — placeAt it directly (like pump_spots). */
  drill_outputs?: Array<{ x: number, y: number, furnace_at?: { x: number, y: number } }>
}

/**
 * The closed capability surface exposed to skill code inside the sandbox.
 * It maps 1:1 onto the `autorio_operations` primitives plus perception, so the
 * action vocabulary stays closed while composition (skills calling skills via
 * `ops.skill`) stays open.
 */
export interface Ops {
  /** Read a fresh world snapshot mid-skill. */
  getState: () => Promise<GameState>
  /** Structured spatial scan: nearby entities (position/direction/status) + resource patches. */
  scan: (radius?: number) => Promise<ScanResult>
  /** Force-wide census of the player's OWN machines (drills/furnaces/assemblers/belts/inserters/containers with status/mining/recipe) — NOT player-centred, so it sees machines anywhere on the surface. Use this for idempotency: a `scan(radius)` centred on the player misses a placed drill once the player drifts off-patch. */
  scanFactory: () => Promise<ScanResult>
  /** ASCII minimap centred on `center` (defaults to your character). Top row = x ruler (a label every 5 columns); each other row is prefixed by its EXACT y. Read footprints (a 2x2 machine fills 2x2 cells), adjacency and belt/inserter orientation (^>v<) straight off the grid, then place with `placeAt` using the EXACT coordinates shown. Null on failure. */
  renderMap: (radius?: number, center?: { x: number, y: number }) => Promise<MapView | null>
  /** Look up the EXACT recipe for an item/machine (ingredients + products). Null if unknown/no recipe. Use this instead of guessing recipes. */
  getRecipe: (name: string) => Promise<RecipeInfo | null>
  /** Look up a placeable entity's mechanics (type, energy/fuel need, tile size, what a drill mines). Null if not a known entity. */
  describeEntity: (name: string) => Promise<EntityInfo | null>
  /** DIAGNOSE one machine: deep detail for the entity at/near a tile (posed recipe, input/output/fuel contents, fluid link state, which ingredient is short). Call when `scan` shows a status that isn't 'working' to learn WHY. Null if no machine there. */
  getEntity: (at: { x: number, y: number }) => Promise<EntityDetail | null>
  /** Locate the NEAREST thing of a name far beyond scan range — ore/coal/water (water is a tile, scan never sees it). Null if none within ~400 tiles. */
  findNearest: (name: string) => Promise<NearestResult | null>
  /** Validated placeAt tiles for `name` near a point (defaults to your position) — pick one by INTENT (e.g. nearest to a drill output) instead of reading exact coords off the map ruler. `{spots:[{x,y}]}` nearest-first (≤12), empty if none placeable in range. Each spot is can_place-verified, so placeAt won't be rejected for being blocked. */
  placementSpots: (name: string, near?: { x: number, y: number }, radius?: number, direction?: 'north' | 'east' | 'south' | 'west') => Promise<{ spots: Array<{ x: number, y: number }> }>
  /** RESEARCH the full production chain for an item (raw materials to mine + intermediates to make, in order + what's research-locked). Use this instead of remembering the tech tree. */
  craftPlan: (item: string, count?: number) => Promise<CraftPlan | null>
  /** RESEARCH which technology unlocks an item's recipe (+ its science cost & prerequisites). `unlocked:true` = already available. */
  techFor: (item: string) => Promise<TechInfo | null>
  /** RESEARCH what an item is FOR: the recipes that consume it. Empty if it's an end-product / unused. */
  usedIn: (item: string) => Promise<string[]>
  /** The force's cumulative production/consumption counters — what was MADE (not just held). Use it to verify real output: compare before/after a chain runs. NOTE: hand-mining/crafting counts too. */
  productionStats: () => Promise<{ produced: Record<string, number>, consumed: Record<string, number> } | null>
  walkToEntity: (entityName: string, searchRadius?: number) => Promise<OpResult>
  /** Walk to an arbitrary tile (x,y) — the ONLY way to reach a spot with no entity, e.g. a water shore for an offshore-pump (water is a tile, walkToEntity can't target it). The character stops within reach. */
  walkTo: (x: number, y: number) => Promise<OpResult>
  mineEntity: (entityName: string, count?: number) => Promise<OpResult>
  /** Place ONE entity at EXACT coords (no snapping). The ONLY placement op. (x,y) is the machine's CENTER: a 2x2 (drill/furnace/assembler) covers the four tiles UP-and-LEFT of (x,y) — (x-1,y-1)..(x,y) — so to COVER a target tile T pass (T.x+1, T.y+1). 1x1 entities sit on their own tile. Read coords off `renderMap` (or use ready coords like pump_spots / drill_outputs.furnace_at). On success `data` carries `{x,y,status,name}` (the confirmed tile + the just-placed entity's status), so you can react without a follow-up scan; may be absent on older mods. */
  placeAt: (entityName: string, at: { x: number, y: number, direction?: 'north' | 'east' | 'south' | 'west' | 'northeast' | 'southeast' | 'southwest' | 'northwest' }) => Promise<OpResult>
  /** Place a mining drill on the nearest patch of a SPECIFIC resource and confirm it mines it (the mod finds the patch + seats the 2x2 — don't compute coords). Walk near the resource first. e.g. `placeDrillOn('iron-ore')`. `{ok:false,error}` if it can't seat the drill ON that resource. PREFER this over placeAt for drills. */
  placeDrillOn: (resource: string, drillName?: string) => Promise<OpResult>
  /** Put a furnace ON the nearest drill's output tile so it's fed hands-free (automation rung 2 — the mod computes the drop tile). Use THIS to fix a drill reading `waiting_for_space_in_destination`. Idempotent; clears your own misplaced furnaces blocking the spot. Then fuel both with coal. e.g. `placeFurnaceAtDrill()`. PREFER this over placeAt for the drill->furnace feed. ONLY for SMELTABLE ore (iron/copper) — for coal/stone use placeChestAtDrill. */
  placeFurnaceAtDrill: (furnaceName?: string) => Promise<OpResult>
  /** Put a CHEST ON the nearest drill's output tile — the coal/stone equivalent of placeFurnaceAtDrill (those don't smelt, so a furnace is wrong; the drill must drop into a chest). The mod computes the exact drop tile (placeNextTo can't — it misses it). Use to fix a coal/stone drill reading `waiting_for_space_in_destination`. Idempotent; clears your own misplaced chests. `chestName` defaults 'wooden-chest'. e.g. `placeChestAtDrill()`. */
  placeChestAtDrill: (chestName?: string) => Promise<OpResult>
  /** AUTOMATE a raw resource in ONE call: walk to it → place a drill → add the RIGHT output (a FURNACE for smeltable ore iron-ore/copper-ore, else a CHEST for coal/stone) → fuel the drill (and furnace). Use this for EVERY raw resource instead of hand-mining. **Automate COAL early with `automateResource('coal')`** — coal fuels every burner machine; hand-mining it forever is why the factory stalls. e.g. `automateResource('iron-ore')`, `automateResource('coal')`. Returns `{ok, data:{resource, output:'furnace'|'chest', mining}}`. */
  automateResource: (resource: string, drillName?: string) => Promise<OpResult>
  /** Hand-bootstrap the factory from an EMPTY inventory so the automation primitives can take over: mine 10 iron-ore + 10 stone + 10 coal, smelt 5 iron-plate, craft 2 iron-gear-wheel + 1 burner-mining-drill + a spare stone-furnace. Needed because `automateResource('iron-ore')` can't start from scratch (it calls `ensure('burner-mining-drill')` → `craftAll('iron-plate')`, and iron-plate is SMELTED not crafted). The first roadmap rung. Returns `{ok, data:{ironPlate}}`. */
  bootstrap: () => Promise<OpResult>
  /** Lay a straight L-shaped line of ALIGNED belts from one tile to another (the mod snaps to tile centres + orients each belt toward the flow). Reuses belts already on the path. Returns `{ok, data:{placed, reused, blocked:[{x,y}]}}`; `ok` false if any tile was blocked — mine the obstacle / pick a clear path and retry. e.g. `placeBeltLine(10,4,10,12)`. */
  placeBeltLine: (startX: number, startY: number, endX: number, endY: number, beltName?: string) => Promise<OpResult>
  /** Place a correctly-ORIENTED inserter between two machines so items flow `from` -> `to` (the mod computes the tile + facing). `inserterName` defaults to 'burner-inserter' (needs coal, no power). e.g. furnace plates onto a belt: `placeInserterBetween('stone-furnace','transport-belt')`. PREFER this over placeAt for inserters. */
  placeInserterBetween: (fromName: string, toName: string, inserterName?: string) => Promise<OpResult>
  /** Connect (startX,startY) -> (endX,endY) along an L-path; the mod resolves every tile/facing/spacing. `kind`='belt' (belts oriented toward the flow), 'pipe' (auto-connecting pipes), or 'power' (electric poles spaced so the chain auto-connects). Take endpoints from `scan()`. Returns `{ok, data:{placed,reused,blocked:[{x,y}]}}`; `ok:false` if a tile was blocked (mine the obstacle / reroute). e.g. wire a lab to a steam-engine: `connect(engineX,engineY, labX,labY, 'power')`. */
  connect: (startX: number, startY: number, endX: number, endY: number, kind?: 'belt' | 'pipe' | 'power', name?: string) => Promise<OpResult>
  /** Power a machine from your steam-engine in ONE call: locates the nearest steam-engine + the nearest `targetName`, ENSURES you hold a pole (crafts it from copper-plate + wood if needed), then lays a pole line between them. This is THE fix for a steam-engine stuck `not_plugged_in_electric_network` or a machine reading `no_power`. Needs copper automated (for the pole). e.g. `connectPowerTo('lab')`, `connectPowerTo('assembling-machine-1')`. */
  connectPowerTo: (targetName: string, poleName?: string) => Promise<OpResult>
  /** Place `entity` on a free tile ADJACENT to the nearest `targetName` machine (the mod finds the spot — don't compute coords). e.g. `placeNextTo('assembling-machine-1','iron-chest')`, `placeNextTo('lab','small-electric-pole')`. Returns `{ok, data:{x,y,status}}`. */
  placeNextTo: (entity: string, targetName: string, side?: string) => Promise<OpResult>
  moveItems: (args: { item: string, entity: string, maxCount?: number, toEntity?: boolean }) => Promise<OpResult>
  craftItem: (recipe: string, count?: number) => Promise<OpResult>
  /** Set the recipe of the nearest crafting machine within 20 tiles — assembler, chemical-plant OR oil-refinery (all entity-type 'assembling-machine'). It produces NOTHING without one (and needs ELECTRICITY). Place the machine, walk to it, then `setRecipe('iron-gear-wheel')` / `setRecipe('sulfuric-acid')`. This is how you AUTOMATE an intermediate or fluid product. */
  setRecipe: (recipe: string) => Promise<OpResult>
  /** Hand-craft `item` AND its whole intermediate chain (the mod reads the recipe graph and crafts leaves-first — you never compute ingredient amounts). PREFER this over `craftItem` for anything with sub-ingredients (e.g. `craftAll('offshore-pump')` makes the pipes + gears first). `{ok:false}` if a step needs research (with what to research) or a smelted input you must make in a furnace first. */
  craftAll: (item: string, count?: number) => Promise<OpResult>
  /** Guarantee you HOLD `count` of `item`: if short, the mod crafts it (craftable → `craftAll`) or mines it (raw resource → walk + mine), then you have it. Use before any step that consumes an item so you never act empty-handed. e.g. `ensure('coal', 10)`, `ensure('iron-gear-wheel', 4)`. */
  ensure: (item: string, count?: number) => Promise<OpResult>
  /** Fuel a machine in ONE call: guarantees you hold the fuel (obtains it if not), walks to the nearest `entityName`, and loads `amount` of `item` (default coal ×5). Replaces the walk-then-moveItems dance that kept failing "out of reach". e.g. `fuel('stone-furnace')`, `fuel('burner-mining-drill', 'coal', 10)`. */
  fuel: (entityName: string, item?: string, amount?: number) => Promise<OpResult>
  /** Fuel the SPECIFIC machine at `at` — NOT the nearest. Use after placing a drill/furnace when another same-name machine is within 32 tiles: `move_items` (radius 32, no distance priority) would SPLIT the fuel across both (the new machine got 0 and the rung stalled). Walks to the target, then steps away from the nearest OTHER same-name machine so only the target is within 32, then loads `amount` of `item` (default coal ×5). e.g. `fuelAt('burner-mining-drill', {x,y})`. */
  fuelAt: (entityName: string, at: { x: number, y: number }, item?: string, amount?: number) => Promise<OpResult>
  /** Walk to the nearest `entityName` and empty its OUTPUT into your inventory (clears a `full_output` machine). Omit `item` to auto-detect what's in its output slots. e.g. `collectOutput('stone-furnace')` to grab smelted plates. */
  collectOutput: (entityName: string, item?: string) => Promise<OpResult>
  /** Launch the nearest rocket-silo's finished rocket (within 60 tiles). The silo must already HOLD a completed rocket — give it the rocket-part recipe + ingredients (it assembles automatically) and wait first. `{ok:false}` with `rocketParts` count if no rocket is ready. */
  launchRocket: () => Promise<OpResult>
  /** Deterministically build a fluid-aligned steam-power chain in ONE call: places offshore-pump -> boiler -> steam-engine (alignment verified by the game), fuels the boiler with your coal, and wires a pole if you have one. Walk NEAR water first and hold the items (1 offshore-pump, 1 boiler, 1 steam-engine, coal). Use this instead of hand-placing the chain — the fluid faces are a fixed mechanism, not a layout you read off the map. */
  buildSteamPower: () => Promise<SteamPowerResult>
  /** AUTOMATE an intermediate (gear/circuit/science…) in ONE call: finds a source producing each input item, places an assembler, sets the recipe, routes belts + inserters from each source to the assembler, wires a power pole (needs steam power on the network), adds an output chest, and verifies the assembler's status. Use this for EVERY intermediate — NEVER place belts/inserters/assemblers by hand (the solver does the geometry). e.g. `buildChain('iron-gear-wheel', ['iron-plate'])`, `buildChain('electronic-circuit', ['iron-plate','copper-plate'])`. Returns `{ok, data:{assembler:{x,y,status}, note}}`. */
  buildChain: (recipe: string, inputs: string[], assemblerName?: string, outputChest?: boolean) => Promise<OpResult>
  researchTechnology: (technologyName: string) => Promise<OpResult>
  wait: (ticks: number) => Promise<OpResult>
  attackNearestEnemy: (searchRadius?: number) => Promise<OpResult>
  /** Invoke another learned skill by name (composition). */
  skill: (name: string, ...args: unknown[]) => Promise<OpResult>
  /** Record a progress message (surfaced to the critic on failure). */
  log: (message: string) => void
  readonly logs: string[]
}

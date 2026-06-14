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
}

/** The critic's verdict on whether an objective was achieved. */
export interface Verdict {
  reasoning?: string
  success: boolean
  critique: string
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
  /** ASCII minimap centred on `center` (defaults to your character). Top row = x ruler (a label every 5 columns); each other row is prefixed by its EXACT y. Read footprints (a 2x2 machine fills 2x2 cells), adjacency and belt/inserter orientation (^>v<) straight off the grid, then place with `placeAt` using the EXACT coordinates shown. Null on failure. */
  renderMap: (radius?: number, center?: { x: number, y: number }) => Promise<MapView | null>
  /** Look up the EXACT recipe for an item/machine (ingredients + products). Null if unknown/no recipe. Use this instead of guessing recipes. */
  getRecipe: (name: string) => Promise<RecipeInfo | null>
  /** Look up a placeable entity's mechanics (type, energy/fuel need, tile size, what a drill mines). Null if not a known entity. */
  describeEntity: (name: string) => Promise<EntityInfo | null>
  /** Locate the NEAREST thing of a name far beyond scan range — ore/coal/water (water is a tile, scan never sees it). Null if none within ~400 tiles. */
  findNearest: (name: string) => Promise<NearestResult | null>
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
  /** Place ONE entity at EXACT tile coords (no snapping). This is the ONLY placement op — there are no auto-placement helpers. Read the target tile + a free orientation off `renderMap` and pass the exact numbers; a 2x2 machine (drill/furnace/assembler) occupies the tile at (x,y) and the 3 tiles +1 right/down. */
  placeAt: (entityName: string, at: { x: number, y: number, direction?: 'north' | 'east' | 'south' | 'west' | 'northeast' | 'southeast' | 'southwest' | 'northwest' }) => Promise<OpResult>
  moveItems: (args: { item: string, entity: string, maxCount?: number, toEntity?: boolean }) => Promise<OpResult>
  craftItem: (recipe: string, count?: number) => Promise<OpResult>
  /** Set the recipe of the nearest assembling-machine — it produces NOTHING without one (and assemblers need ELECTRICITY). Place the assembler, walk to it, then `setRecipe('iron-gear-wheel')`. This is how you AUTOMATE an intermediate instead of hand-crafting it. */
  setRecipe: (recipe: string) => Promise<OpResult>
  /** Deterministically build a fluid-aligned steam-power chain in ONE call: places offshore-pump -> boiler -> steam-engine (alignment verified by the game), fuels the boiler with your coal, and wires a pole if you have one. Walk NEAR water first and hold the items (1 offshore-pump, 1 boiler, 1 steam-engine, coal). Use this instead of hand-placing the chain — the fluid faces are a fixed mechanism, not a layout you read off the map. */
  buildSteamPower: () => Promise<SteamPowerResult>
  researchTechnology: (technologyName: string) => Promise<OpResult>
  wait: (ticks: number) => Promise<OpResult>
  attackNearestEnemy: (searchRadius?: number) => Promise<OpResult>
  /** Invoke another learned skill by name (composition). */
  skill: (name: string, ...args: unknown[]) => Promise<OpResult>
  /** Record a progress message (surfaced to the critic on failure). */
  log: (message: string) => void
  readonly logs: string[]
}

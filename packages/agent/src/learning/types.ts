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
  walkToEntity: (entityName: string, searchRadius?: number) => Promise<OpResult>
  mineEntity: (entityName: string, count?: number) => Promise<OpResult>
  placeEntity: (entityName: string) => Promise<OpResult>
  /** Place ONE entity at EXACT tile coords with orientation (no snapping) — for aligned lines. */
  placeAt: (entityName: string, at: { x: number, y: number, direction?: 'north' | 'east' | 'south' | 'west' | 'northeast' | 'southeast' | 'southwest' | 'northwest' }) => Promise<OpResult>
  /** Place a correctly-ORIENTED inserter between two machines so items flow `from` -> `to` (the mod computes the tile + facing; don't compute it yourself). `inserterName` defaults to 'burner-inserter' (works with NO power). e.g. take plates from a furnace onto a belt: `placeInserterBetween('stone-furnace','transport-belt')`. */
  placeInserterBetween: (fromName: string, toName: string, inserterName?: string) => Promise<OpResult>
  /** Lay a straight L-shaped line of ALIGNED belts from one tile to another (the mod snaps to tile centres + orients each belt toward the flow — don't compute coords/facing yourself). Reuses belts already on the path. Returns `{ok, data:{placed, reused, blocked:[{x,y}]}}`; `ok` is false if any tile was blocked — mine the obstacle (or pick a clear start/end) and call again. e.g. carry ore from a drill at (10,4) to a furnace row at (10,12): `placeBeltLine(10,4,10,12)`. */
  placeBeltLine: (startX: number, startY: number, endX: number, endY: number, beltName?: string) => Promise<OpResult>
  /** Place a mining drill on the nearest patch of a SPECIFIC resource and confirm it mines it. Use THIS for drills, not `placeEntity` — placeEntity auto-snaps to the nearest resource of ANY type, so a drill meant for iron can land on a closer stone/copper patch. `drillName` defaults to 'burner-mining-drill'. Walk near the resource first. e.g. `placeDrillOn('iron-ore')`. Returns `{ok:false, error}` if it can't seat the drill ON that resource. */
  placeDrillOn: (resource: string, drillName?: string) => Promise<OpResult>
  moveItems: (args: { item: string, entity: string, maxCount?: number, toEntity?: boolean }) => Promise<OpResult>
  craftItem: (recipe: string, count?: number) => Promise<OpResult>
  researchTechnology: (technologyName: string) => Promise<OpResult>
  wait: (ticks: number) => Promise<OpResult>
  attackNearestEnemy: (searchRadius?: number) => Promise<OpResult>
  /** Invoke another learned skill by name (composition). */
  skill: (name: string, ...args: unknown[]) => Promise<OpResult>
  /** Record a progress message (surfaced to the critic on failure). */
  log: (message: string) => void
  readonly logs: string[]
}

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
}

/** Result of `ops.scan(radius)`: a structured local map for spatial reasoning + automation checks. */
export interface ScanResult {
  origin?: { x: number, y: number }
  radius?: number
  entities: ScanEntity[]
  /** resource name -> aggregated patch { count, x, y } */
  resources: Record<string, { count: number, x: number, y: number }>
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
  walkToEntity: (entityName: string, searchRadius?: number) => Promise<OpResult>
  mineEntity: (entityName: string, count?: number) => Promise<OpResult>
  placeEntity: (entityName: string) => Promise<OpResult>
  /** Place ONE entity at EXACT tile coords with orientation (no snapping) — for aligned lines. */
  placeAt: (entityName: string, at: { x: number, y: number, direction?: 'north' | 'east' | 'south' | 'west' | 'northeast' | 'southeast' | 'southwest' | 'northwest' }) => Promise<OpResult>
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

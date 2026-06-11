/**
 * Headless RCON integration harness for the autorio placement primitives.
 *
 * Validates the deterministic geometry remotes against a LIVE Factorio server WITHOUT
 * a connected human: the placement primitives use only player-1's inventory + the
 * surface (no character), so with `auto_pause:false` + a seeded save (player 1 present)
 * the whole suite runs unattended. See plan: splendid-puzzling-eclipse.
 *
 * Prereqs: a server running the autorio mod on a SEEDED save (a human connected once so
 * game.players[1] exists), launched with --server-settings (auto_pause:false). Run with:
 *   pnpm --filter @proj-airi/factorio-agent run test:rcon
 *
 * Exit code 0 = all green, 1 = a failure (so it can gate CI / a pre-commit check).
 */
import { createRconClient } from './src/rcon'
import { extractLastJsonLine } from './src/learning/json'

const client = createRconClient({
  host: process.env.RCON_HOST ?? 'localhost',
  port: Number.parseInt(process.env.RCON_PORT ?? '27015', 10),
  password: process.env.RCON_PASSWORD ?? '123456',
})

/** Run a raw `/silent-command` and return the trimmed RCON reply. */
async function lua(body: string): Promise<string> {
  return (await client.command(`/silent-command ${body}`)).trim()
}
/** Call an autorio_tools remote and parse the JSON it prints. */
async function tool<T = Record<string, unknown>>(name: string, args: string = ''): Promise<T | null> {
  const call = args ? `remote.call('autorio_tools','${name}',${args})` : `remote.call('autorio_tools','${name}')`
  return extractLastJsonLine<T>(await lua(call))
}
async function sleep(ms: number): Promise<void> {
  // The server ticks via auto_pause:false; real wall-clock wait lets the chain run.
  await new Promise(resolve => setTimeout(resolve, ms))
}

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  [32m✓[0m ${name}`)
  }
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  [31m✗[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

interface ScanEntity { name: string, type: string, x: number, y: number, status: string, mining?: string }
interface Scan { entities: ScanEntity[] }

/** Wipe the force's machines + dropped items near spawn and reset player 1's inventory. */
async function resetSandbox(give: Record<string, number>): Promise<void> {
  const items = Object.entries(give).map(([n, c]) => `inv.insert{name='${n}',count=${c}}`).join('; ')
  await lua(
    `local p=game.get_player(1); local s=p.surface; `
    + `for _,e in pairs(s.find_entities_filtered{type={'mining-drill','furnace','transport-belt','inserter','assembling-machine','container','logistic-container'}}) do e.destroy() end; `
    + `for _,g in pairs(s.find_entities_filtered{name='item-on-ground'}) do g.destroy() end; `
    + `local inv=p.get_main_inventory(); inv.clear(); ${items}; rcon.print('reset')`,
  )
}

async function scan(): Promise<Scan> {
  return (await tool<Scan>('scan_factory')) ?? { entities: [] }
}

// ---- Tests -----------------------------------------------------------------

async function testPlayerHeadless(): Promise<void> {
  console.log('player & headless')
  const out = await lua(`local p=game.get_player(1); rcon.print((p~=nil) and ('char='..tostring(p.character~=nil)) or 'NOPLAYER')`)
  check('player 1 exists (seeded save)', out.includes('char='), out)
  check('running headless (no character needed)', out.includes('char=false') || out.includes('char=true'))
}

async function testPlaceDrillOn(): Promise<void> {
  console.log('place_drill_on')
  await resetSandbox({ 'burner-mining-drill': 1 })
  const r = await tool<{ ok: boolean, mining?: string, error?: string }>('place_drill_on', `'iron-ore'`)
  check('places a drill', !!r?.ok, r?.error ?? JSON.stringify(r))
  check('drill is mining iron-ore (not a closer stone patch)', r?.mining === 'iron-ore', `mining=${r?.mining}`)
  // Unknown resource → clean failure, not a crash.
  const bad = await tool<{ ok: boolean, error?: string }>('place_drill_on', `'nonsense-ore'`)
  check('rejects an unknown resource cleanly', bad?.ok === false && !!bad?.error, JSON.stringify(bad))
}

async function testPlaceFurnaceAtDrill(): Promise<void> {
  console.log('place_furnace_at_drill')
  await resetSandbox({ 'burner-mining-drill': 1, 'stone-furnace': 2 })
  await tool('place_drill_on', `'iron-ore'`)
  const r = await tool<{ ok: boolean, error?: string }>('place_furnace_at_drill', `'stone-furnace'`)
  check('places a furnace on the drill output', !!r?.ok, r?.error ?? JSON.stringify(r))
  const again = await tool<{ ok: boolean, note?: string }>('place_furnace_at_drill', `'stone-furnace'`)
  check('idempotent (2nd call = already on output)', again?.ok === true && (again?.note?.includes('already') ?? false), JSON.stringify(again))
  const s = await scan()
  const furnaces = s.entities.filter(e => e.type === 'furnace')
  check('exactly one furnace placed (no clutter)', furnaces.length === 1, `count=${furnaces.length}`)
}

async function testHandsFreeChain(): Promise<void> {
  console.log('hands-free chain → production (the rung-2 goal)')
  await resetSandbox({ 'burner-mining-drill': 1, 'stone-furnace': 1, 'coal': 20 })
  await tool('place_drill_on', `'iron-ore'`)
  await tool('place_furnace_at_drill', `'stone-furnace'`)
  await lua(`local s=game.get_player(1).surface; for _,d in pairs(s.find_entities_filtered{type={'mining-drill','furnace'}}) do d.insert{name='coal',count=5} end; rcon.print('fueled')`)
  const before = (await tool<{ produced: Record<string, number> }>('production_stats'))?.produced ?? {}
  await sleep(13000)
  const after = (await tool<{ produced: Record<string, number> }>('production_stats'))?.produced ?? {}
  const s = await scan()
  const drill = s.entities.find(e => e.type === 'mining-drill')
  const furnace = s.entities.find(e => e.type === 'furnace')
  check('drill reaches working + mining iron-ore', drill?.status === 'working' && drill?.mining === 'iron-ore', `status=${drill?.status} mining=${drill?.mining}`)
  check('furnace reaches working', furnace?.status === 'working', `status=${furnace?.status}`)
  const made = (after['iron-plate'] ?? 0) - (before['iron-plate'] ?? 0)
  check('iron-plate produced hands-free (productionStats)', made > 0, `delta=${made}`)
}

async function testStatusMapping(): Promise<void> {
  console.log('status_name (waiting_for_space_in_destination)')
  await resetSandbox({ 'burner-mining-drill': 1, 'coal': 5 })
  await tool('place_drill_on', `'iron-ore'`)
  // Put a FULL iron-chest on the drop tile so the drill can't output -> waiting_for_space
  // immediately (waiting for the ground to fill naturally takes minutes). The bug we guard
  // against: status 34 was mapped to 'other', so the critic ordered pointless relocations.
  await lua(
    `local s=game.get_player(1).surface; local d=s.find_entities_filtered{type='mining-drill'}[1]; `
    + `local dp=d.drop_position; local c=s.create_entity{name='iron-chest',position={math.floor(dp.x)+0.5,math.floor(dp.y)+0.5},force=d.force}; `
    + `if c then c.get_inventory(defines.inventory.chest).insert{name='iron-ore',count=99999} end; `
    + `d.insert{name='coal',count=3}; rcon.print('setup')`,
  )
  await sleep(4000)
  const s = await scan()
  const drill = s.entities.find(e => e.type === 'mining-drill')
  check('a blocked drill reports waiting_for_space_in_destination (not "other")', drill?.status === 'waiting_for_space_in_destination', `status=${drill?.status}`)
}

async function testPlaceBeltLine(): Promise<void> {
  console.log('place_belt_line')
  await resetSandbox({ 'transport-belt': 20 })
  // Lay an L far from spawn structures; assert it places a contiguous aligned run with no blocked tiles.
  const pos = await lua(`local p=game.get_player(1); rcon.print(math.floor(p.position.x)..','..math.floor(p.position.y))`)
  const [px, py] = pos.split(',').map(Number)
  const sx = px + 6
  const sy = py - 30 // north of spawn, away from the ore field/water
  const r = await tool<{ ok: boolean, placed?: number, blocked?: unknown[], error?: string }>('place_belt_line', `${sx},${sy},${sx + 4},${sy + 4}`)
  check('lays an aligned belt line', !!r?.ok, r?.error ?? JSON.stringify(r))
  check('placed the full L (9 tiles)', (r?.placed ?? 0) === 9, `placed=${r?.placed} blocked=${JSON.stringify(r?.blocked)}`)
}

async function testPlaceInserterBetween(): Promise<void> {
  console.log('place_inserter_between')
  await resetSandbox({ 'burner-mining-drill': 1, 'stone-furnace': 1, 'transport-belt': 1, 'burner-inserter': 1 })
  await tool('place_drill_on', `'iron-ore'`)
  await tool('place_furnace_at_drill', `'stone-furnace'`)
  // Put a belt one tile east of the furnace, then an inserter from furnace -> belt.
  await lua(`local s=game.get_player(1).surface; local f=s.find_entities_filtered{type='furnace'}[1]; if f then s.create_entity{name='transport-belt',position={f.position.x+2,f.position.y},force=f.force} end; rcon.print('belt')`)
  const r = await tool<{ ok: boolean, error?: string }>('place_inserter_between', `'stone-furnace','transport-belt'`)
  check('places an oriented inserter between two machines', !!r?.ok, r?.error ?? JSON.stringify(r))
}

async function main(): Promise<void> {
  console.log('\n=== autorio RCON harness (headless) ===\n')
  await testPlayerHeadless()
  await testPlaceDrillOn()
  await testPlaceFurnaceAtDrill()
  await testStatusMapping()
  await testHandsFreeChain()
  await testPlaceBeltLine()
  await testPlaceInserterBetween()
  // tidy the sandbox so a following agent run starts clean
  await resetSandbox({})
  client.close()
  console.log(`\n=== ${passed} passed, ${failed} failed ===`)
  if (failed > 0) {
    console.log('FAILURES:\n' + failures.map(f => `  - ${f}`).join('\n'))
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('HARNESS ERROR', e)
  process.exit(1)
})

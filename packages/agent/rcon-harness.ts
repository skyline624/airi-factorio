/**
 * Headless RCON integration harness for the autorio perception remotes.
 *
 * Validates the read-only remotes (render_map, scan_factory, status mapping) against a LIVE
 * Factorio server WITHOUT a connected human: they use only player-1's data + the surface,
 * so with `auto_pause:false` + a seeded save (player 1 present) the suite runs unattended.
 *
 * NOTE: placement is now the model's job via `placeAt` reading `render_map` — there are no
 * deterministic placement macros to test anymore. Entities here are created directly with
 * create_entity to set up perception scenarios.
 *
 * Prereqs: a server running the autorio mod on a SEEDED save, launched with
 * --server-settings (auto_pause:false). Run with:
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
  await new Promise(resolve => setTimeout(resolve, ms))
}

let passed = 0
let failed = 0
const failures: string[] = []
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  [32m✓[0m ${name}`)
  }
  else {
    failed++
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  [31m✗[0m ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

interface ScanEntity { name: string, type: string, x: number, y: number, status: string, mining?: string, recipe?: string }
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

/** Create a fuelled burner-mining-drill on the nearest iron-ore to player 1; return its tile. */
async function createDrillOnIron(): Promise<{ x: number, y: number }> {
  const out = await lua(
    `local p=game.get_player(1); local s=p.surface; `
    + `local es=s.find_entities_filtered{position=p.position,radius=300,type='resource',name='iron-ore'}; `
    + `local b,bd=nil,1e18; for _,e in pairs(es) do local d=(e.position.x-p.position.x)^2+(e.position.y-p.position.y)^2; if d<bd then bd=d b=e end end; `
    + `local x,y=math.floor(b.position.x),math.floor(b.position.y); `
    + `local d=s.create_entity{name='burner-mining-drill',position={x,y},force=p.force,direction=defines.direction.south}; `
    + `if d then d.insert{name='coal',count=3} end; rcon.print(x..','..y)`,
  )
  const [x, y] = out.split(',').map(Number)
  return { x, y }
}

// ---- P0.2 tests: rich entity returns (fluid content, belt I/O, scan recipe) ----

interface FluidEntry { index: number, fluid?: { name: string, amount: number }, connections: Array<{ flow: string, linked: boolean }> }
interface EntityDetailOut { name: string, type: string, fluids?: FluidEntry[], belt?: { input: { x: number, y: number }, output: { x: number, y: number }, left: Array<{ name: string, count: number }>, right: Array<{ name: string, count: number }> } }

async function testScanRecipe(): Promise<void> {
  console.log('scan_factory recipe field (P0.2)')
  await resetSandbox({})
  // An assembler WITH a recipe and one WITHOUT — scan_factory must surface both, and drills
  // (non-crafting) must omit the recipe field entirely.
  await lua(
    `local p=game.get_player(1); local s=p.surface; local pp=p.position; `
    + `local a1=s.create_entity{name='assembling-machine-1',position={pp.x+2,pp.y},force=p.force}; `
    + `if a1 then a1.set_recipe('iron-gear-wheel') end; `
    + `local a2=s.create_entity{name='assembling-machine-1',position={pp.x+5,pp.y},force=p.force}; `
    + `rcon.print('setup')`,
  )
  const s = await scan()
  const asm = s.entities.filter(e => e.name === 'assembling-machine-1')
  const withRecipe = asm.find(e => e.recipe === 'iron-gear-wheel')
  const noRecipe = asm.find(e => e.recipe === 'none')
  check('scan surfaces the posed recipe on a crafting machine', !!withRecipe, `recipes=${asm.map(e => e.recipe).join('|')}`)
  check('scan surfaces "none" for a crafting machine with no recipe set', !!noRecipe)
  check('scan omits recipe on non-crafting entities (drills)', s.entities.filter(e => e.type === 'mining-drill').every(e => e.recipe === undefined))
}

async function testGetEntityFluids(): Promise<void> {
  console.log('get_entity fluidbox content (P0.2)')
  await resetSandbox({})
  // A storage-tank with water injected into its fluidbox, and an empty one. storage-tank has a
  // single fluidbox that holds any fluid with no neighbour needed — ideal to verify the new
  // `fluid:{name,amount}` field (and the empty-box case where the key is absent).
  const setup = await lua(
    `local p=game.get_player(1); local s=p.surface; local pp=p.position; `
    + `local t1=s.create_entity{name='storage-tank',position={pp.x+2,pp.y},force=p.force}; `
    + `if t1 then t1.fluidbox[1]={name='water',amount=2500} end; `
    + `local t2=s.create_entity{name='storage-tank',position={pp.x+5,pp.y},force=p.force}; `
    + `rcon.print(t1.position.x..','..t1.position.y..'|'..t2.position.x..','..t2.position.y)`,
  )
  const [p1, p2] = setup.split('|')
  const [x1, y1] = p1.split(',').map(Number)
  const [x2, y2] = p2.split(',').map(Number)
  const full = await tool<EntityDetailOut>('get_entity', `${x1},${y1}`)
  check('get_entity surfaces the held fluid (name+amount>0)', full?.fluids?.[0]?.fluid?.name === 'water' && (full?.fluids?.[0]?.fluid?.amount ?? 0) > 0, JSON.stringify(full?.fluids?.[0]))
  const empty = await tool<EntityDetailOut>('get_entity', `${x2},${y2}`)
  check('get_entity surfaces an empty fluidbox as fluid:undefined (key absent)', empty?.fluids?.[0] !== undefined && empty?.fluids?.[0]?.fluid === undefined, JSON.stringify(empty?.fluids?.[0]))
}

async function testGetEntityBelt(): Promise<void> {
  console.log('get_entity belt input/output + lanes (P0.2)')
  await resetSandbox({})
  // An east-facing belt with 3 iron-plates inserted on its left lane. The mod derives input
  // (back) / output (front) from the facing, and reads each lane's contents.
  const setup = await lua(
    `local p=game.get_player(1); local s=p.surface; local pp=p.position; `
    + `local b=s.create_entity{name='transport-belt',position={pp.x+2,pp.y},force=p.force,direction=defines.direction.east}; `
    + `if b then b.get_transport_line(1).insert_at_back({name='iron-plate',count=3}) end; `
    + `rcon.print(b.position.x..','..b.position.y)`,
  )
  const [bx, by] = setup.split(',').map(Number)
  const d = await tool<EntityDetailOut>('get_entity', `${bx},${by}`)
  check('belt surfaces input/output tiles', !!d?.belt?.input && !!d?.belt?.output, JSON.stringify(d?.belt))
  // East-facing: items move +x, so the output (front) is east of the input (back).
  check('belt output is east of input (facing east)', d?.belt?.output?.x !== undefined && d?.belt?.input?.x !== undefined && d.belt.output.x > d.belt.input.x, `in=${JSON.stringify(d?.belt?.input)} out=${JSON.stringify(d?.belt?.output)}`)
  check('belt left lane carries the inserted items', d?.belt?.left?.some(i => i.name === 'iron-plate') === true, JSON.stringify(d?.belt?.left))
  check('belt right lane is empty', (d?.belt?.right?.length ?? 0) === 0, JSON.stringify(d?.belt?.right))
}

// ---- Tests -----------------------------------------------------------------

async function testPlayerHeadless(): Promise<void> {
  console.log('player & headless')
  const out = await lua(`local p=game.get_player(1); rcon.print((p~=nil) and ('char='..tostring(p.character~=nil)) or 'NOPLAYER')`)
  check('player 1 exists (seeded save)', out.includes('char='), out)
  check('running headless (no character needed)', out.includes('char=false') || out.includes('char=true'))
}

async function testRenderMap(): Promise<void> {
  console.log('render_map (ASCII minimap)')
  await resetSandbox({})
  const d = await createDrillOnIron()
  const m = await tool<{ grid?: string[], legend?: string, origin?: { x: number, y: number } }>('render_map', `${d.x},${d.y},10`)
  const grid = m?.grid ?? []
  check('returns a grid of rows', Array.isArray(m?.grid) && grid.length > 2, `rows=${grid.length}`)
  const blob = grid.join('\n')
  check('shows the drill (D) and iron ore (i)', blob.includes('D') && blob.includes('i'), grid.slice(0, 3).join(' | '))
  check('top row is an x-ruler (has digits)', /-?\d/.test(grid[0] ?? ''), `row0="${grid[0]}"`)
  check('rows are y-labelled (start with a number)', /^\s*-?\d/.test(grid[1] ?? ''), `row1="${grid[1]}"`)
}

async function testStatusMapping(): Promise<void> {
  console.log('status_name (waiting_for_space_in_destination)')
  await resetSandbox({})
  await createDrillOnIron()
  // Put a FULL iron-chest on the drop tile so the drill can't output -> waiting_for_space
  // immediately. The bug guarded against: status 34 mapped to 'other', so the critic ordered
  // pointless relocations.
  await lua(
    `local s=game.get_player(1).surface; local d=s.find_entities_filtered{type='mining-drill'}[1]; `
    + `local dp=d.drop_position; local c=s.create_entity{name='iron-chest',position={math.floor(dp.x)+0.5,math.floor(dp.y)+0.5},force=d.force}; `
    + `if c then c.get_inventory(defines.inventory.chest).insert{name='iron-ore',count=99999} end; `
    + `rcon.print('setup')`,
  )
  await sleep(4000)
  const s = await scan()
  const drill = s.entities.find(e => e.type === 'mining-drill')
  check('a blocked drill reports waiting_for_space_in_destination (not "other")', drill?.status === 'waiting_for_space_in_destination', `status=${drill?.status}`)
}

async function main(): Promise<void> {
  console.log('\n=== autorio RCON harness (headless) ===\n')
  await testPlayerHeadless()
  await testRenderMap()
  await testStatusMapping()
  await testScanRecipe()
  await testGetEntityFluids()
  await testGetEntityBelt()
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

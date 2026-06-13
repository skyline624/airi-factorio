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

/**
 * One-shot RCON reset of the headless test sandbox: destroy the force's machines + dropped items
 * and clear player 1's inventory, WITHOUT recreating the map. Preserves player 1 (required for
 * headless — the mod resolves the player via game.get_player(1) and create_character() fails on a
 * dedicated server), the terrain, the ore patches and any character. Run AFTER the wrapper has
 * started the server and BEFORE the agent, so the learning loop starts from a clean factory + an
 * empty inventory (the "reset usine/inventaire" step) — this lets the agent reach the
 * furnace-placement rung in a handful of objectives instead of spending ~10 re-bootstrapping coal.
 *
 * Usage (server already running on RCON 27015):
 *   pnpm --filter @proj-airi/factorio-agent exec vite-node reset-factory.ts
 */
import { createRconClient } from './src/rcon'

async function main(): Promise<void> {
  const client = createRconClient({
    host: process.env.RCON_HOST ?? 'localhost',
    port: Number.parseInt(process.env.RCON_PORT ?? '27015', 10),
    password: process.env.RCON_PASSWORD ?? 'airi',
  })
  // Same wipe set as rcon-harness.resetSandbox (machines + ground items), plus a player-1 inventory
  // clear. The character and all resource patches are untouched. We ALSO cancel_all_tasks first:
  // the save may carry a stale task (e.g. a WALKING_TO_ENTITY from the previous run) — once the
  // machines are destroyed the on_tick would process that stale task, log an [ERROR] (e.g. "no
  // stone-furnace within 50 to walk to"), and the agent would capture that stale settle on its
  // very first op (cross-task contamination — the #1 cause of "ensure: failed mining 'coal': no
  // stone-furnace within 50"). Cancelling the queue + resetting task_state to IDLE before the wipe
  // ensures no stale task runs after the reset.
  const body = `local p=game.get_player(1); local s=p.surface; `
    + `remote.call('autorio_operations','cancel_all_tasks'); `
    + `for _,e in pairs(s.find_entities_filtered{type={'mining-drill','furnace','transport-belt','inserter','assembling-machine','container','logistic-container'}}) do e.destroy() end; `
    + `for _,g in pairs(s.find_entities_filtered{name='item-on-ground'}) do g.destroy() end; `
    + `local inv=p.get_main_inventory(); if inv then inv.clear() end; `
    + `rcon.print('reset done')`
  const out = (await client.command(`/c ${body}`)).trim()
  console.log('[reset-factory]', out)
  client.close()
}

main().catch((e: Error) => {
  console.error('[reset-factory] failed:', e.message)
  process.exit(1)
})
import { createLogg } from '@guiiai/logg'
import { z } from 'zod'
import { rconCommand } from '../rcon.js'

const logger = createLogg('tools').useGlobalConfig()

interface ToolFunction {
  name: string
  description: string
  schema: z.Schema
  fn: (args: any) => Promise<any>
}

export const tools: ToolFunction[] = [
  {
    name: 'getInventoryItems',
    description: 'Get the items in the player\'s inventory',
    schema: z.object({}),
    fn: async () => {
      const output = await rconCommand('/c remote.call("autorio_tools", "get_inventory_items", 1)')
      logger.withFields({ response: output }).debug('Inventory items')
      return output
    },
  },
  {
    name: 'getRecipe',
    description: 'Get the recipe for a given item',
    schema: z.object({
      item: z.string().describe('The item to get the recipe for'),
    }),
    fn: async ({ parameters }) => {
      logger.withFields(parameters).debug('Try to get recipe for item')

      const output = await rconCommand(`/c remote.call("autorio_tools", "get_recipe", "${parameters.item}", 1)`)
      logger.withFields({ response: output }).debug('Recipe')
      return output
    },
  },
  {
    name: 'getPlayerStatus',
    description: 'Get the player\'s current survival status: health, whether under attack, nearby enemies, and equipped weapons/ammo. Use this to decide whether to fight, flee, or continue a task.',
    schema: z.object({}),
    fn: async () => {
      const output = await rconCommand('/c remote.call("autorio_tools", "get_player_status", 1)')
      logger.withFields({ response: output }).debug('Player status')
      return output
    },
  },
]

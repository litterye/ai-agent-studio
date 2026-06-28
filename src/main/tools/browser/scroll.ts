import { z } from 'zod'
import { getPage } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  direction: z.enum(['down', 'up']).optional()
    .describe('Scroll direction (default "down").'),
  amount: z.number().int().positive().optional()
    .describe('Pixels to scroll (default 500).')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_scroll',
  description:
    'Scroll the page up or down by a given number of pixels. ' +
    'Returns a fresh snapshot after scrolling.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', enum: ['down', 'up'], description: 'Scroll direction.' },
      amount: { type: 'number', description: 'Pixels to scroll (default 500).' }
    },
    required: [],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '📜',
  maxResultSizeChars: 40_000,
  async handler(input) {
    const page = getPage()
    const direction = input.direction ?? 'down'
    const amount = input.amount ?? 500
    const delta = direction === 'up' ? -amount : amount
    await page.evaluate((d) => window.scrollBy({ top: d, behavior: 'smooth' }), delta)
    await page.waitForTimeout(200)
    return await buildSnapshot(page, 'compact')
  }
}

export function createBrowserScrollTool(): AgentTool {
  return {
    name: def.name, description: def.description, inputSchema: def.jsonSchema,
    source: 'builtin', toolset: def.toolset,
    needsConfirmation: def.needsConfirmation ?? false, emoji: def.emoji,
    maxResultSizeChars: def.maxResultSizeChars,
    async run(input: unknown): Promise<string> {
      return def.handler(def.schema.parse(input))
    }
  }
}

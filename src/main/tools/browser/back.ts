import { z } from 'zod'
import { getPage } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_back',
  description:
    'Navigate back to the previous page in browser history. Returns a fresh snapshot.',
  schema,
  jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '⬅️',
  maxResultSizeChars: 40_000,
  async handler() {
    const page = getPage()
    await page.goBack({ timeout: 10_000 })
    await page.waitForLoadState('domcontentloaded')
    return await buildSnapshot(page, 'compact')
  }
}

export function createBrowserBackTool(): AgentTool {
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

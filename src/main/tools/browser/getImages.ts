import { z } from 'zod'
import { getPage } from './BrowserManager'
import { imageSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_get_images',
  description:
    'Get all image URLs from the current page with dimensions and alt text. ' +
    'Useful for finding specific images to download or reference.',
  schema,
  jsonSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '🖼️',
  maxResultSizeChars: 15_000,
  async handler() {
    return await imageSnapshot(getPage())
  }
}

export function createBrowserGetImagesTool(): AgentTool {
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

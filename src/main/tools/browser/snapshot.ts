import { z } from 'zod'
import { getPage } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  mode: z.enum(['compact', 'full']).optional()
    .describe('compact = interactive elements only with [ref=eN] tags. full = all text nodes for reading content.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_snapshot',
  description:
    'Get an accessibility snapshot of the current page showing interactive elements with [ref=eN] IDs. ' +
    'Use mode="full" to include all text content for reading. ' +
    'Use mode="compact" (default) for a concise list of clickable/typable elements.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: { mode: { type: 'string', enum: ['compact', 'full'], description: 'Snapshot mode.' } },
    required: [],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '📸',
  maxResultSizeChars: 50_000,
  async handler(input) {
    return await buildSnapshot(getPage(), input.mode ?? 'compact')
  }
}

export function createBrowserSnapshotTool(): AgentTool {
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

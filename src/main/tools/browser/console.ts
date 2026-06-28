import { z } from 'zod'
import { getPage } from './BrowserManager'
import { consoleSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  expression: z.string().optional()
    .describe('Optional JavaScript expression to evaluate in the page context. If omitted, returns recent console messages.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_console',
  description:
    'Read browser console messages (errors, warnings, logs) or evaluate a JavaScript expression. ' +
    'Pass an expression like "document.title" or "JSON.stringify(window.__data)" to extract values ' +
    'from the page. Omit expression to just read recent console output.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: { expression: { type: 'string', description: 'JS expression to evaluate (optional).' } },
    required: [],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '🖥️',
  maxResultSizeChars: 20_000,
  async handler(input) {
    return await consoleSnapshot(getPage(), input.expression)
  }
}

export function createBrowserConsoleTool(): AgentTool {
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

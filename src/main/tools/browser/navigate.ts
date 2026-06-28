import { z } from 'zod'
import { navigate } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  url: z.string().describe('The URL to navigate to. HTTP is upgraded to HTTPS.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_navigate',
  description:
    'Navigate the browser to a URL. Returns an accessibility snapshot of the page ' +
    'with interactive elements tagged with [ref=eN] IDs. Use this to start a browser ' +
    'session or follow links. After navigating, use browser_snapshot, browser_click, ' +
    'or browser_type to interact with the page.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: { url: { type: 'string', description: 'The URL to navigate to.' } },
    required: ['url'],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '🌐',
  maxResultSizeChars: 40_000,
  async handler(input) {
    let url = input.url.trim()
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    // Quick URL validation
    try { new URL(url) } catch { throw new Error(`Invalid URL: ${url}`) }
    if (url.startsWith('http://')) url = 'https://' + url.slice(7)

    const page = await navigate(url)
    const snapshot = await buildSnapshot(page, 'compact')
    return snapshot
  }
}

export function createBrowserNavigateTool(): AgentTool {
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

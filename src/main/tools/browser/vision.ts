import { z } from 'zod'
import { getPage } from './BrowserManager'
import { visionScreenshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  annotate: z.boolean().optional()
    .describe('If true, add bounding boxes and element labels to the screenshot for layout analysis.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_vision',
  description:
    'Take a screenshot of the current page and return it as a base64 JPEG data URL. ' +
    'Use annotate=true to overlay element bounding boxes for layout debugging. ' +
    'The returned data URL can be used in image analysis workflows. ' +
    'Also returns page dimensions and viewport info.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      annotate: { type: 'boolean', description: 'Overlay element boxes on the screenshot (default false).' }
    },
    required: [],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '📷',
  maxResultSizeChars: 300_000, // base64 is large
  async handler(input) {
    const page = getPage()
    const { dataUrl, width, height } = await visionScreenshot(page)

    let extra = ''
    if (input.annotate ?? false) {
      // Get count of visible interactive elements
      const count = await page.evaluate(() => {
        const els = document.querySelectorAll('a, button, input, select, textarea, [role="button"], [role="link"], [role="textbox"]')
        const visible: any[] = []
        els.forEach((el) => {
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            const tag = el.tagName.toLowerCase()
            const text = (el as HTMLElement).innerText?.slice(0, 40) || ''
            visible.push({ tag, text, x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) })
          }
        })
        return visible
      })
      extra = `\n\n## Annotated elements (${count.length} visible)\n${count.map((e: any) => `- <${e.tag}> "${e.text}" at (${e.x},${e.y}) ${e.w}x${e.h}`).join('\n')}`
    }

    return `## Screenshot\n\nViewport: ${width}x${height}\nFormat: JPEG base64\nData URL length: ${dataUrl.length} chars\n\n${dataUrl}${extra}`
  }
}

export function createBrowserVisionTool(): AgentTool {
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

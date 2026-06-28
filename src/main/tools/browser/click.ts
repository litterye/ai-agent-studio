import { z } from 'zod'
import { getPage, state } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  ref: z.number().int().positive().describe('The [ref=eN] number from the snapshot to click.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_click',
  description:
    'Click an interactive element on the page identified by its [ref=eN] ID from the latest snapshot. ' +
    'After clicking, a new snapshot is returned reflecting any page changes.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: { ref: { type: 'number', description: 'The [ref=eN] number from the snapshot.' } },
    required: ['ref'],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '👆',
  maxResultSizeChars: 40_000,
  async handler(input) {
    const page = getPage()
    const label = state.refMap.get(input.ref)
    if (!label) throw new Error(`No element with ref=e${input.ref} in the current snapshot. Re-snapshot first.`)

    const [role, ...nameParts] = label.split(' ')
    const name = nameParts.join(' ').replace(/"/g, '').trim()

    let clicked = false

    // Strategy 1: use Playwright getByRole
    try {
      const locator = page.getByRole(role as any, name ? { name } : undefined)
      await locator.first().click({ timeout: 5000 })
      clicked = true
    } catch {
      // ignore
    }

    // Strategy 2: click by visibility-ordered interactive element index
    if (!clicked) {
      try {
        await page.evaluate((n) => {
          const sel = 'a[href],button,input:not([type="hidden"]),select,textarea,[role="button"],[role="link"],[role="textbox"],[role="searchbox"],[role="combobox"],[contenteditable="true"],[onclick]'
          const els = document.querySelectorAll(sel)
          let visibleIdx = 0
          for (const el of els) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              if (visibleIdx === n) {
                (el as HTMLElement).click()
                return
              }
              visibleIdx++
            }
          }
          throw new Error('Index ' + n + ' out of range')
        }, input.ref - 1)
        clicked = true
      } catch {
        // will throw below
      }
    }

    if (!clicked) {
      throw new Error(`Could not click element [ref=e${input.ref}] (${label}).`)
    }

    await page.waitForLoadState('domcontentloaded').catch(() => {})
    await page.waitForTimeout(500)

    return await buildSnapshot(page, 'compact')
  }
}

export function createBrowserClickTool(): AgentTool {
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

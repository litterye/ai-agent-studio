import { z } from 'zod'
import { getPage, state } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  ref: z.number().int().positive().describe('The [ref=eN] number of a textbox/searchbox/combobox element.'),
  text: z.string().describe('The text to type into the element.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_type',
  description:
    'Type text into an input/textarea/combobox element identified by its [ref=eN] ID. ' +
    'Clears the existing value first, then types the given text. ' +
    'Returns a fresh snapshot after typing.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      ref: { type: 'number', description: 'The [ref=eN] number of the input element.' },
      text: { type: 'string', description: 'The text to type.' }
    },
    required: ['ref', 'text'],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '⌨️',
  maxResultSizeChars: 40_000,
  async handler(input) {
    const page = getPage()
    const label = state.refMap.get(input.ref)
    if (!label) throw new Error(`No element with ref=e${input.ref} in the current snapshot.`)

    const [role, ...nameParts] = label.split(' ')
    const name = nameParts.join(' ').replace(/"/g, '').trim()

    let filled = false

    // Strategy 1: use Playwright getByRole
    try {
      const locator = page.getByRole(role as any, name ? { name } : undefined)
      await locator.first().clear()
      await locator.first().fill(input.text, { timeout: 5000 })
      filled = true
    } catch {
      // ignore
    }

    // Strategy 2: use visibility-ordered input elements
    if (!filled) {
      try {
        await page.evaluate(({ n, text }) => {
          const sel = 'input:not([type="hidden"]),textarea,[contenteditable="true"],[role="textbox"],[role="searchbox"],[role="combobox"]'
          const els = document.querySelectorAll(sel)
          let visibleIdx = 0
          for (const el of els) {
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              if (visibleIdx === n) {
                const input = el as HTMLInputElement
                input.focus()
                input.value = ''
                input.dispatchEvent(new Event('input', { bubbles: true }))
                // Use execCommand or direct value for contenteditable
                if (el.getAttribute('contenteditable') === 'true') {
                  el.textContent = ''
                }
                // Simulate typing each character for reactivity
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
                if (nativeInputValueSetter) {
                  nativeInputValueSetter.call(input, text)
                } else {
                  input.value = text
                }
                input.dispatchEvent(new Event('input', { bubbles: true }))
                input.dispatchEvent(new Event('change', { bubbles: true }))
                return
              }
              visibleIdx++
            }
          }
          throw new Error('Index ' + n + ' out of range')
        }, { n: input.ref - 1, text: input.text })
        filled = true
      } catch {
        // will throw below
      }
    }

    if (!filled) {
      throw new Error(`Could not type into [ref=e${input.ref}] (${label}).`)
    }

    await page.waitForTimeout(300)
    return await buildSnapshot(page, 'compact')
  }
}

export function createBrowserTypeTool(): AgentTool {
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

import { z } from 'zod'
import { getPage } from './BrowserManager'
import { buildSnapshot } from './accessibility'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  key: z.string().describe('The key to press. Common: Enter, Escape, Tab, ArrowDown, ArrowUp, PageDown, Space, Backspace, Delete.')
})

const def: BuiltinToolDef<z.infer<typeof schema>> = {
  name: 'browser_press',
  description:
    'Press a keyboard key on the page. Common keys: Enter (submit form/confirm), Escape (close modal/menu), ' +
    'Tab (next field), ArrowDown/ArrowUp/PageDown (navigate), Space (scroll/checkbox), Backspace/Delete. ' +
    'Returns a fresh snapshot after the key press.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: { key: { type: 'string', description: 'Key name to press (e.g. Enter, Escape, Tab, ArrowDown).' } },
    required: ['key'],
    additionalProperties: false
  },
  toolset: 'browser',
  needsConfirmation: false,
  emoji: '⌨️',
  maxResultSizeChars: 40_000,
  async handler(input) {
    const page = getPage()
    const key = input.key.trim()
    // Map common names to Playwright key names
    const keyMap: Record<string, string> = {
      enter: 'Enter', escape: 'Escape', tab: 'Tab',
      arrowdown: 'ArrowDown', arrowup: 'ArrowUp',
      arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
      pagedown: 'PageDown', pageup: 'PageUp',
      backspace: 'Backspace', 'delete': 'Delete',
      space: ' ', home: 'Home', end: 'End'
    }
    const mapped = keyMap[key.toLowerCase()] ?? key
    await page.keyboard.press(mapped)
    await page.waitForTimeout(300)
    return await buildSnapshot(page, 'compact')
  }
}

export function createBrowserPressTool(): AgentTool {
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

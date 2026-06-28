import { z } from 'zod'
import type { AgentTool } from '../types'
import { localBackend } from '../../workspace/localBackend'
import { isWriteDenied } from '../../workspace/fileSafety'

const PatchSchema = z.object({
  oldText: z.string().min(1),
  newText: z.string()
})

const Schema = z.object({
  path: z.string().min(1),
  patches: z.array(PatchSchema).min(1).max(20)
})

export function createPatchFileTool(): AgentTool {
  return {
    name: 'patch_file',
    description:
      'Apply one or more find-and-replace patches to a file. Each patch ' +
      'replaces the first occurrence of oldText with newText. Returns an ' +
      'error if any patch does not match (the file is not modified).',
    toolset: 'file',
    source: 'builtin',
    needsConfirmation: true,
    emoji: '🔧',
    maxResultSizeChars: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file.' },
        patches: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              oldText: { type: 'string' },
              newText: { type: 'string' }
            },
            required: ['oldText', 'newText'],
            additionalProperties: false
          },
          description: 'Array of {oldText, newText} patches. Applied in order.',
          maxItems: 20
        }
      },
      required: ['path', 'patches'],
      additionalProperties: false
    },
    run: async (input) => {
      const { path, patches } = Schema.parse(input)
      const cwd = process.env['AGENT_STUDIO_CWD']?.trim() || process.cwd()
      const abs = localBackend.resolvePath(path, cwd)
      const denied = isWriteDenied(abs)
      if (denied) return `Patch denied: ${denied}`
      const ok = await localBackend.patch(abs, patches)
      if (!ok) return 'Patch failed: one or more oldText blocks did not match.'
      return `Patched ${path} with ${patches.length} change(s).`
    }
  }
}
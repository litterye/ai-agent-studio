import { z } from 'zod'
import type { AgentTool } from '../types'
import { getToolRunContext } from '../types'
import { localBackend } from '../../workspace/localBackend'
import { isWriteDenied } from '../../workspace/fileSafety'

const Schema = z.object({
  path: z.string().min(1),
  content: z.string()
})

export function createWriteFileTool(): AgentTool {
  return {
    name: 'write_file',
    description:
      'Write content to a file, creating or overwriting it. ' +
      'Relative paths resolve against the active working directory.',
    toolset: 'file',
    source: 'builtin',
    needsConfirmation: true,
    emoji: '✏️',
    maxResultSizeChars: 10_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file (absolute, or relative to cwd).' },
        content: { type: 'string', description: 'Content to write.' }
      },
      required: ['path', 'content'],
      additionalProperties: false
    },
    run: async (input) => {
      const { path, content } = Schema.parse(input)
      const cwd = getToolRunContext().cwd
      const abs = localBackend.resolvePath(path, cwd)
      const denied = isWriteDenied(abs)
      if (denied) return `Write denied: ${denied}`
      await localBackend.write(abs, content)
      return `Wrote ${content.length} bytes to ${abs}.`
    }
  }
}
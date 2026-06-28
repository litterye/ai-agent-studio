import { z } from 'zod'
import type { AgentTool } from '../types'
import { localBackend } from '../../workspace/localBackend'

const Schema = z.object({
  path: z.string().min(1)
})

export function createListDirectoryTool(): AgentTool {
  return {
    name: 'list_directory',
    description:
      'List the contents of a directory. Returns entry names, kind (file/dir), ' +
      'size in bytes, and last-modified timestamp.',
    toolset: 'file',
    source: 'builtin',
    needsConfirmation: false,
    emoji: '📂',
    maxResultSizeChars: 30_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path (absolute, or relative to cwd).' }
      },
      required: ['path'],
      additionalProperties: false
    },
    run: async (input) => {
      const { path } = Schema.parse(input)
      const cwd = process.env['AGENT_STUDIO_CWD']?.trim() || process.cwd()
      const abs = localBackend.resolvePath(path, cwd)
      const entries = await localBackend.list(abs)
      if (entries.length === 0) return `Directory is empty: ${abs}`
      return entries
        .map((e) => {
          const icon = e.kind === 'dir' ? '📁' : '📄'
          const kb = e.size > 0 ? ` (${formatSize(e.size)})` : ''
          return `${icon}  ${e.name}${kb}`
        })
        .join('\n')
    }
  }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
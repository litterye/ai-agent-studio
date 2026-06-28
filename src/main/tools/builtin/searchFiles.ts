import { z } from 'zod'
import type { AgentTool } from '../types'
import { localBackend } from '../../workspace/localBackend'

const Schema = z.object({
  path: z.string().min(1),
  query: z.string().min(1),
  glob: z.string().optional(),
  maxResults: z.number().int().min(1).max(200).optional()
})

export function createSearchFilesTool(): AgentTool {
  return {
    name: 'search_files',
    description:
      'Search for a literal string under a directory, recursively. ' +
      'Returns matching file paths, line numbers, and the matching line content.',
    toolset: 'file',
    source: 'builtin',
    needsConfirmation: false,
    emoji: '🔍',
    maxResultSizeChars: 50_000,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to search in.' },
        query: { type: 'string', description: 'Literal string to find.' },
        glob: { type: 'string', description: 'Optional glob filter, e.g. "*.ts" or "**/*.vue".' },
        maxResults: { type: 'number', description: 'Max results (default 30).' }
      },
      required: ['path', 'query'],
      additionalProperties: false
    },
    run: async (input) => {
      const { path, query, glob, maxResults } = Schema.parse(input)
      const cwd = process.env['AGENT_STUDIO_CWD']?.trim() || process.cwd()
      const abs = localBackend.resolvePath(path, cwd)
      const hits = await localBackend.search(abs, query, glob, maxResults ?? 30)
      if (hits.length === 0) return `No matches found for "${query}" under ${abs}.`
      return hits
        .map(
          (h) => `${h.path}:${h.line}:${h.column} | ${h.lineContent.slice(0, 200)}`
        )
        .join('\n')
    }
  }
}
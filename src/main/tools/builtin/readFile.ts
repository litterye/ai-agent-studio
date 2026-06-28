import { z } from 'zod'
import { readFile as fsReadFile, stat } from 'fs/promises'
import { resolve, isAbsolute } from 'path'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  path: z.string().describe('Absolute or project-relative path to the file to read.')
})

type Input = z.infer<typeof schema>

const MAX_BYTES = 256 * 1024

const def: BuiltinToolDef<Input> = {
  name: 'read_file',
  description:
    'Read a UTF-8 text file from the local filesystem and return its contents. Use when the user asks to read, inspect, or summarize a file on disk.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or project-relative path to the file to read.' }
    },
    required: ['path'],
    additionalProperties: false
  },
  toolset: 'file',
  needsConfirmation: false,
  emoji: '📄',
  maxResultSizeChars: 100_000,
  async handler(input) {
    // Resolve against cwd; reject nothing by default but guard size & type.
    const abs = isAbsolute(input.path) ? input.path : resolve(process.cwd(), input.path)
    const info = await stat(abs)
    if (!info.isFile()) throw new Error(`Not a file: ${abs}`)
    if (info.size > MAX_BYTES) {
      throw new Error(`File too large (${info.size} bytes, max ${MAX_BYTES}).`)
    }
    return await fsReadFile(abs, 'utf-8')
  }
}

/** Wrap a builtin definition into the AgentTool interface with zod validation. */
export function createReadFileTool(): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.jsonSchema,
    source: 'builtin',
    toolset: def.toolset,
    needsConfirmation: def.needsConfirmation ?? false,
    emoji: def.emoji,
    maxResultSizeChars: def.maxResultSizeChars,
    async run(input: unknown): Promise<string> {
      const parsed = def.schema.parse(input)
      return def.handler(parsed)
    }
  }
}

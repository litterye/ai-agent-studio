import { z } from 'zod'
import { spawn } from 'child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  runtime: z
    .enum(['node', 'python'])
    .describe('Which runtime to use.'),
  code: z.string().describe('The source code to execute. Use require/import (Node) or standard library modules.'),
  timeoutMs: z.number().int().positive().max(60_000).optional().describe('Max execution time in ms (default 15000, max 60000).')
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT = 100_000
const DEFAULT_TIMEOUT = 15_000

const def: BuiltinToolDef<Input> = {
  name: 'execute_code',
  description:
    'Execute a Node.js (JavaScript) or Python script and return stdout/stderr. ' +
    'The script runs in a temp directory; use absolute paths for file access. ' +
    'For Node: use require() for built-in modules (fs, path, http, etc). ' +
    'For Python: standard library modules are available (os, sys, json, http, etc). ' +
    'Output is capped at 100 KB. Execution is sandboxed by timeout only — ' +
    'avoid destructive operations.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      runtime: { type: 'string', enum: ['node', 'python'], description: 'Runtime: node or python.' },
      code: { type: 'string', description: 'Source code to execute.' },
      timeoutMs: { type: 'number', description: 'Max execution time in ms (default 15000, max 60000).' }
    },
    required: ['runtime', 'code'],
    additionalProperties: false
  },
  toolset: 'tasks',
  needsConfirmation: true,
  emoji: '⚡',
  maxResultSizeChars: MAX_OUTPUT,
  async handler(input) {
    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT
    const isNode = input.runtime === 'node'

    // Write script to temp file
    const tmpDir = mkdtempSync(join(tmpdir(), 'agent-exec-'))
    const ext = isNode ? '.js' : '.py'
    const scriptPath = join(tmpDir, `script${ext}`)

    try {
      writeFileSync(scriptPath, input.code, 'utf-8')

      const cmd = isNode ? process.execPath : 'python'
      const args = isNode ? [scriptPath] : [scriptPath]

      const result = await new Promise<string>((resolve) => {
        const child = spawn(cmd, args, {
          cwd: tmpDir,
          env: process.env,
          windowsHide: true,
          timeout
        })

        let out = ''
        let truncated = false
        const append = (label: string, chunk: Buffer | string): void => {
          const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
          if (out.length + s.length > MAX_OUTPUT) {
            const remaining = MAX_OUTPUT - out.length
            if (remaining > 0) out += s.slice(0, remaining)
            truncated = true
          } else {
            out += (out ? '' : `[${label}]\n`) + s
          }
        }

        child.stdout.on('data', (d: Buffer) => append('stdout', d))
        child.stderr.on('data', (d: Buffer) => append('stderr', d))

        child.on('error', (err) => {
          resolve(`Error spawning ${cmd}: ${err.message}`)
        })

        child.on('close', (code, signal) => {
          const suffix = truncated ? `\n\n[... output truncated at ${MAX_OUTPUT} chars ...]` : ''
          const exit = signal ? `killed (${signal})` : `exit code ${code ?? 'null'}`
          resolve(`${out}${suffix}\n[${exit}]`)
        })
      })

      return result
    } finally {
      // Clean up temp dir
      try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

export function createExecuteCodeTool(): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.jsonSchema,
    source: 'builtin',
    toolset: def.toolset,
    needsConfirmation: def.needsConfirmation ?? true,
    emoji: def.emoji,
    maxResultSizeChars: def.maxResultSizeChars,
    async run(input: unknown): Promise<string> {
      return def.handler(def.schema.parse(input))
    }
  }
}

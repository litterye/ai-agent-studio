import { z } from 'zod'
import { spawn } from 'child_process'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  command: z.string().min(1).describe('The command line to execute.'),
  cwd: z.string().optional().describe('Override the working directory.'),
  timeoutMs: z.number().int().positive().optional().describe('Timeout in milliseconds (default 30000).')
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT_CHARS = 100_000
const DEFAULT_TIMEOUT_MS = 30_000

const def: BuiltinToolDef<Input> = {
  name: 'terminal',
  description:
    'Run a shell command. On Windows uses cmd.exe, on macOS/Linux uses /bin/sh. ' +
    'Output is captured (stdout and stderr combined) and truncated to 100 KB. ' +
    'Use absolute paths or paths relative to the active working directory. ' +
    'Common commands: dir/ls (list files), cd (change directory), echo, type/cat, ' +
    'mkdir, npm, pip, git, python, node, etc.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to execute.' },
      cwd: { type: 'string', description: 'Override the working directory (absolute or relative).' },
      timeoutMs: { type: 'number', description: 'Timeout in milliseconds (default 30000).' }
    },
    required: ['command'],
    additionalProperties: false
  },
  toolset: 'terminal',
  needsConfirmation: true,
  emoji: '🖥️',
  maxResultSizeChars: MAX_OUTPUT_CHARS,
  async handler(input) {
    const isWin = process.platform === 'win32'
    const shell = isWin
      ? (process.env['COMSPEC'] ?? 'cmd.exe')
      : (process.env['SHELL'] ?? '/bin/sh')
    const args = isWin ? ['/d', '/s', '/c', input.command] : ['-c', input.command]

    // Resolve cwd: input.cwd > env hint > process.cwd
    let cwd = input.cwd?.trim() || null
    if (!cwd) {
      const envCwd = process.env['AGENT_STUDIO_CWD']?.trim()
      cwd = envCwd || process.cwd()
    }

    const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise<string>((resolve) => {
      const child = spawn(shell, args, { cwd, env: process.env, windowsHide: true })

      let out = ''
      let truncated = false

      const append = (chunk: Buffer | string): void => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
        if (out.length + s.length > MAX_OUTPUT_CHARS) {
          const remaining = MAX_OUTPUT_CHARS - out.length
          if (remaining > 0) out += s.slice(0, remaining)
          truncated = true
        } else {
          out += s
        }
      }

      child.stdout.on('data', append)
      child.stderr.on('data', append)

      let killed = false
      const timer = setTimeout(() => {
        killed = true
        try { child.kill() } catch { /* ignore */ }
      }, timeout)

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve(`Error spawning shell (${shell}): ${err.message}`)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        const suffix = truncated
          ? `\n\n[... output truncated at ${MAX_OUTPUT_CHARS} chars ...]`
          : ''
        const exit = killed
          ? 'killed (timeout)'
          : `exit code ${code ?? 'null'}`
        resolve(`${out}${suffix}\n[${exit}]`)
      })
    })
  }
}

export function createTerminalTool(): AgentTool {
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
      const parsed = def.schema.parse(input)
      return def.handler(parsed)
    }
  }
}

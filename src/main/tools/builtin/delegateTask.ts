import { z } from 'zod'
import { randomUUID } from 'crypto'
import type { AgentTool, BuiltinToolDef } from '../types'
import type { AgentEvent, ChatMessage } from '@shared/ipc'

/**
 * Maximum sub-agent nesting depth. `delegate_task` inside a delegate_task
 * is allowed once; deeper calls are rejected to prevent runaway recursion.
 */
let subAgentDepth = 0
const MAX_DEPTH = 2

const schema = z.object({
  prompt: z.string().min(1).describe('The task description for the sub-agent. Be specific about the expected output format.'),
  label: z.string().optional().describe('A short label for this delegation (appears in progress notes).')
})

type Input = z.infer<typeof schema>

const MAX_OUTPUT_CHARS = 80_000

const def: BuiltinToolDef<Input> = {
  name: 'delegate_task',
  description:
    'Spawn a sub-agent to work on a focused task in parallel. ' +
    'The sub-agent has access to the same tools as the parent (read_file, search_files, ' +
    'terminal, WebFetch, WebSearch, browser, etc.). It runs for up to 10 turns and returns ' +
    'a structured result. Use this to parallelize research, run independent analyses, or ' +
    'verify your work. The sub-agent cannot delegate further tasks. ' +
    'Always include a clear prompt describing the expected output.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'Task description for the sub-agent.' },
      label: { type: 'string', description: 'Short label for this delegation.' }
    },
    required: ['prompt'],
    additionalProperties: false
  },
  toolset: 'tasks',
  needsConfirmation: false,
  emoji: '🤖',
  maxResultSizeChars: MAX_OUTPUT_CHARS,
  async handler(input) {
    if (subAgentDepth >= MAX_DEPTH) {
      return 'Error: maximum delegation depth reached. A sub-agent cannot spawn additional sub-agents.'
    }

    const prompt = input.prompt.trim()
    const label = input.label?.trim() || prompt.slice(0, 60)

    // Lazy-import to break circular dependency:
    //   tools → registryBootstrap → index → AgentService → tools
    const { agentService } = await import('../../agent/AgentService')

    const runId = randomUUID()
    const history: ChatMessage[] = [{ role: 'user', content: prompt }]

    // Collect all events without emitting to the renderer
    const textParts: string[] = []
    const toolCalls: Array<{ name: string; input: unknown; result: string; isError: boolean }> = []

    subAgentDepth++

    try {
      await new Promise<void>((resolve) => {
        const cb = {
          emit(event: AgentEvent): void {
            switch (event.type) {
              case 'text_delta':
                textParts.push(event.text)
                break
              case 'tool_use':
                toolCalls.push({ name: event.toolName, input: event.input, result: '', isError: false })
                break
              case 'tool_result':
                if (toolCalls.length > 0) {
                  const last = toolCalls[toolCalls.length - 1]
                  if (last.name === event.toolName && !last.result) {
                    last.result = event.content
                    last.isError = event.isError
                  }
                }
                break
              case 'done':
              case 'error':
              case 'cancelled':
                resolve()
                break
            }
          },
          confirm: async () => ({ approved: true }),
          isCancelled: () => false
        }

        void agentService.run(runId, history, cb as any, null, undefined)
      })
    } finally {
      subAgentDepth--
    }

    const finalText = textParts.join('')

    // Build structured output
    const lines: string[] = []
    lines.push(`## Sub-agent result: ${label}`)
    lines.push('')
    if (finalText.trim()) {
      lines.push('### Response')
      lines.push(finalText.trim())
      lines.push('')
    }
    if (toolCalls.length > 0) {
      lines.push(`### Tool calls (${toolCalls.length})`)
      for (const tc of toolCalls) {
        const inputStr = typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        lines.push(`- \`${tc.name}\` ${tc.isError ? '❌' : '✓'}`)
        lines.push(`  input: ${inputStr.slice(0, 200)}`)
        if (tc.result) {
          lines.push(`  result: ${tc.result.slice(0, 300)}`)
        }
      }
    }

    return lines.join('\n')
  }
}

export function createDelegateTaskTool(): AgentTool {
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
      return def.handler(def.schema.parse(input))
    }
  }
}

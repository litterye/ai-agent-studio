import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'

/**
 * Per-session in-memory task list. Keyed by runId (== session key).
 * The agent can create, list, and update tasks for the current conversation.
 */
const tasks = new Map<string, { id: number; content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }[]>()

let nextId = 1

const schema = z.object({
  action: z
    .enum(['list', 'add', 'update', 'remove'])
    .describe('What to do with the task list: list all, add new, update status, or remove.'),
  id: z.number().int().optional().describe('Task ID (required for update/remove).'),
  content: z.string().optional().describe('Task description (required for add).'),
  status: z.enum(['pending', 'in_progress', 'completed']).optional().describe('New status (for update).'),
  activeForm: z.string().optional().describe('Present-tense label shown while in progress (for add/update).')
})

type Input = z.infer<typeof schema>

const def: BuiltinToolDef<Input> = {
  name: 'todo',
  description:
    'Manage a per-session task list. Use to track progress on complex multi-step tasks. ' +
    'Actions: "list" — show current tasks; "add" — create a task (needs content + activeForm); ' +
    '"update" — change a task status (needs id + status); "remove" — delete a task (needs id).',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'update', 'remove'], description: 'Action to perform.' },
      id: { type: 'number', description: 'Task ID (for update/remove).' },
      content: { type: 'string', description: 'Task description (for add).' },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'Task status (for update).' },
      activeForm: { type: 'string', description: 'Present-tense label while in progress (e.g. "Implementing login").' }
    },
    required: ['action'],
    additionalProperties: false
  },
  toolset: 'tasks',
  needsConfirmation: false,
  emoji: '✅',
  maxResultSizeChars: 10_000,
  async handler(input) {
    // Use a synthetic session key from env (set by AgentService)
    const sessionKey = process.env['AGENT_STUDIO_CWD'] ?? 'default'
    let list = tasks.get(sessionKey)
    if (!list) {
      list = []
      tasks.set(sessionKey, list)
    }

    switch (input.action) {
      case 'list': {
        if (list.length === 0) return 'Task list is empty.'
        const lines = list.map((t) => {
          const icon = { pending: '⬜', in_progress: '🔄', completed: '✅' }[t.status]
          return `${icon} #${t.id} [${t.status}] ${t.content}${t.activeForm ? ` (active: ${t.activeForm})` : ''}`
        })
        return `## Task list (${list.length} items)\n\n${lines.join('\n')}`
      }

      case 'add': {
        if (!input.content) return 'Error: "content" is required for add.'
        const id = nextId++
        const item = {
          id,
          content: input.content,
          status: (input.status as 'pending' | 'in_progress' | 'completed') || 'pending',
          activeForm: input.activeForm || input.content
        }
        list.push(item)
        return `Task #${id} added: "${input.content}" [${item.status}]`
      }

      case 'update': {
        if (!input.id) return 'Error: "id" is required for update.'
        const item = list.find((t) => t.id === input.id)
        if (!item) return `Error: task #${input.id} not found.`
        if (input.status) item.status = input.status as 'pending' | 'in_progress' | 'completed'
        if (input.activeForm) item.activeForm = input.activeForm
        if (input.content) item.content = input.content
        return `Task #${input.id} updated: "${item.content}" [${item.status}]`
      }

      case 'remove': {
        if (!input.id) return 'Error: "id" is required for remove.'
        const idx = list.findIndex((t) => t.id === input.id)
        if (idx === -1) return `Error: task #${input.id} not found.`
        const removed = list.splice(idx, 1)[0]
        return `Task #${input.id} removed: "${removed.content}"`
      }

      default:
        return `Unknown action: ${(input as any).action}`
    }
  }
}

export function createTodoTool(): AgentTool {
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

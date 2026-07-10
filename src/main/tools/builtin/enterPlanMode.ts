import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'
import { getToolRunContext } from '../types'
import { planState } from '../../agent/planState'

/**
 * Enter plan mode: switch the current session into read-only planning mode.
 * The system prompt is modified and write tools are restricted until the
 * agent calls exit_plan_mode.
 *
 * This tool can be called by the agent when it detects the user wants to
 * design/plan something, OR via the /plan slash command which the renderer
 * detects and enters plan mode automatically.
 */

const schema = z.object({
  goal: z.string().describe('What the user wants planned. A one-line summary.')
})

type Input = z.infer<typeof schema>

const def: BuiltinToolDef<Input> = {
  name: 'enter_plan_mode',
  description:
    'Enter plan mode — restrict the agent to read-only exploration and design. ' +
    'Use this when the user asks you to plan, design, or architect something. ' +
    'In plan mode you can only use read tools (read_file, search_files, list_directory, ' +
    'WebSearch, WebFetch, skill_view, todo). Write tools and terminal are disabled. ' +
    'Call exit_plan_mode when the plan is complete to save it and request user approval.\n' +
    'The plan mode is per-session: all subsequent messages in this session stay in ' +
    'plan mode until exit_plan_mode is called.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      goal: {
        type: 'string',
        description: 'What the user wants planned — a one-line summary.'
      }
    },
    required: ['goal'],
    additionalProperties: false
  },
  toolset: 'plan',
  needsConfirmation: false,
  emoji: '📋',
  maxResultSizeChars: 2_000,
  async handler(input) {
    const ctx = getToolRunContext()
    const sessionId = ctx.sessionId
    if (!sessionId) {
      return 'Error: no active session. Plan mode requires a session context.'
    }

    if (planState.isActive(sessionId)) {
      return `Already in plan mode (goal: "${planState.getGoal(sessionId)}"). Call exit_plan_mode to exit.`
    }

    planState.enter(sessionId, input.goal)

    return [
      '✅ Plan mode activated.',
      '',
      `**Goal:** ${input.goal}`,
      '',
      '**What changed:**',
      '- Write tools are now disabled (no editing source files).',
      '- Terminal is disabled.',
      '- Only read/exploration tools are available.',
      '- The system prompt has been updated with planning instructions.',
      '',
      '**What to do:**',
      '1. Explore the codebase to understand current architecture.',
      '2. Discuss requirements with the user (ask clarifying questions).',
      '3. Present design options with trade-offs.',
      '4. When done, call `exit_plan_mode` with the complete plan document.',
      '',
      '**Exit:** Use `exit_plan_mode` to save the plan and request user approval.'
    ].join('\n')
  }
}

export function createEnterPlanModeTool(): AgentTool {
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

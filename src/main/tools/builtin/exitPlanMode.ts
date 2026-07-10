import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'
import { getToolRunContext } from '../types'
import { writePlan } from '../../workspace/plans'
import { planState } from '../../agent/planState'

/**
 * Exit plan mode: write the plan to a .plans/ directory file and signal
 * that the user should review and approve before implementation begins.
 *
 * After this tool runs, the session exits plan mode — write tools become
 * available again on the next turn.
 */

const schema = z.object({
  body: z.string().describe(
    'The complete plan document in markdown format. Must include: Goal, Scope, ' +
    'Tech Stack, Architecture, Implementation Steps, and Constraints sections.'
  ),
  slug: z.string().optional().describe(
    'Short filename-safe identifier for the plan (e.g. "add-login-feature"). ' +
    'Defaults to "plan" if omitted.'
  )
})

type Input = z.infer<typeof schema>

const def: BuiltinToolDef<Input> = {
  name: 'exit_plan_mode',
  description:
    'Exit plan mode by saving the plan document and requesting user approval. ' +
    'Call this when your exploration and design are complete. Provide the full ' +
    'plan in markdown format. After this call, the user will review the plan and ' +
    'decide whether to approve it for implementation.\n' +
    'The plan MUST include: Goal, Scope (v1), Tech Stack decisions, Architecture, ' +
    'Implementation Steps (numbered, actionable), and Constraints.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      body: {
        type: 'string',
        description: 'Complete plan document in markdown.'
      },
      slug: {
        type: 'string',
        description: 'Short filename-safe identifier for the plan.'
      }
    },
    required: ['body'],
    additionalProperties: false
  },
  toolset: 'plan',
  needsConfirmation: false,
  emoji: '📋',
  maxResultSizeChars: 5_000,
  async handler(input) {
    const ctx = getToolRunContext()
    const cwd = ctx.cwd
    const slug = input.slug || 'plan'

    const result = writePlan(cwd, slug, input.body)

    if (!result.ok) {
      return `Failed to write plan: ${result.error}`
    }

    // Exit plan mode for all active sessions (cleanup)
    for (const sid of planState.activeSessions()) {
      planState.exit(sid)
    }

    return [
      '✅ Plan saved and plan mode exited.',
      '',
      `**Plan file:** \`${result.path}\``,
      '',
      'The user will now review the plan. They can:',
      '- Approve it and ask you to begin implementation (you will have write tools restored).',
      '- Request changes to specific sections.',
      '- Reject it and provide new direction.',
      '',
      '## Summary',
      '',
      'The following sections were written to the plan:',
      '- **Goal** — what this plan aims to achieve',
      '- **Scope (v1)** — in-scope and out-of-scope features',
      '- **Tech Stack** — technology choices with rationale',
      '- **Architecture** — project structure, components, data flow',
      '- **Implementation Steps** — numbered, actionable tasks',
      '- **Constraints** — limitations and requirements',
      '',
      '**Next:** Wait for user feedback before making any changes.'
    ].join('\n')
  }
}

export function createExitPlanModeTool(): AgentTool {
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

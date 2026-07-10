import { toolRegistry } from '../tools/registry'
import { configStore } from '../config/store'
import type { ChatMessage } from '@shared/ipc'
import type { AgentCallbacks, AgentRunner, RunContext } from './runners/types'
import { AnthropicRunner } from './runners/AnthropicRunner'
import { OpenAIRunner } from './runners/OpenAIRunner'
import { getApprovalsConfig } from '../approvals/config'
import { getWorkspaceConfig } from '../config/workspaceConfig'
import { buildSkillsIndex } from '../skills/promptBuilder'
import { loadSoul } from '../identity/soul'
import { memoryService } from '../memory/MemoryService'
import type { MemoryRow } from '../db/memoryStore'
import { planState } from './planState'
import type { AgentTool } from '../tools/types'

export type { AgentCallbacks, RunContext } from './runners/types'

/**
 * Dispatches an agent run to the protocol-specific runner.
 * Both runners share the same tool registry and callback surface.
 */
export class AgentService {
  private anthropic = new AnthropicRunner()
  private openai = new OpenAIRunner()

  /**
   * Run the agent. `sessionKey` identifies the conversation for cwd resolution.
   * `sessionId` is the DB session ID (for memory extraction tracing).
   * `overrides` allows per-session model/protocol overrides from the DB.
   */
  async run(
    runId: string,
    history: ChatMessage[],
    cb: AgentCallbacks,
    sessionKey?: string | null,
    sessionId?: string | null,
    overrides?: { model?: string; protocol?: string; effort?: string; baseUrl?: string; visionMode?: string; apiKey?: string },
    isCron?: boolean
  ): Promise<void> {
    try {
      // Resolve model & protocol early — the system prompt needs them
      const settings = configStore.getSettings()
      const protocol = overrides?.protocol ?? settings.protocol
      const model = overrides?.model ?? settings.model

      // Resolve active toolsets for this session
      const approvals = getApprovalsConfig()
      const activeToolsets = new Set<string>(approvals.toolsets.default)

      // Recursion guard — cron jobs cannot schedule more cron jobs (Hermes parity).
      // Also exclude messaging/clarify toolsets that don't make sense headless.
      if (isCron) {
        activeToolsets.delete('cron')
        activeToolsets.delete('messaging')
        activeToolsets.delete('clarify')
      }
      // If the user pinned a session cwd, inject it into the system prompt
      const workspace = getWorkspaceConfig()
      const cwd = resolveCwd(workspace.sessions[sessionKey ?? ''] || workspace.defaultCwd)

      // Build tool list filtered by active toolsets
      let tools = await toolRegistry.forSession(activeToolsets)

      // ── Plan mode: restrict to read-only + planning tools ──────────────
      const planActive = planState.isActive(sessionId ?? undefined)
      if (planActive) {
        const planTools = new Set([
          'read_file', 'search_files', 'list_directory',   // file-read ops
          'skill_view', 'skill_manage',                     // skill introspection
          'WebSearch', 'WebFetch',                          // web research
          'todo',                                           // task tracking
          'enter_plan_mode',                                // enter plan mode
          'exit_plan_mode'                                  // exit + request approval
        ])
        tools = tools.filter((t) => planTools.has(t.name))
      }

      // Retrieve relevant cross-session memories
      const lastUserMsg = history.filter((m) => m.role === 'user').pop()?.content ?? ''
      const relevantMemories = memoryService.getRelevant(lastUserMsg, 5)

      const system = buildSystemPrompt({
        tools,
        activeToolsets,
        cwd,
        model,
        protocol,
        memories: relevantMemories,
        isCron,
        planGoal: planActive ? planState.getGoal(sessionId ?? undefined) : undefined
      })

      const ctx: RunContext = {
        system,
        cwd,
        activeToolsets,
        modelOverride: overrides?.model,
        protocolOverride: overrides?.protocol,
        effortOverride: overrides?.effort,
        baseUrlOverride: overrides?.baseUrl,
        visionModeOverride: overrides?.visionMode,
        apiKeyOverride: overrides?.apiKey,
        sessionId: sessionId ?? undefined,
        isCron,
        planGoal: planActive ? planState.getGoal(sessionId ?? undefined) : undefined
      }

      // Side-channel so the terminal builtin can find the active cwd without
      // receiving it directly via input. Cleared after the run.
      // Other tools use getToolRunContext() (set by executeToolCall) instead.
      process.env['AGENT_STUDIO_CWD'] = cwd
      try {
        const runner: AgentRunner =
          protocol === 'openai' ? this.openai : this.anthropic
        await runner.run(runId, history, tools, cb, ctx)
      } finally {
        if (process.env['AGENT_STUDIO_CWD'] === cwd) {
          delete process.env['AGENT_STUDIO_CWD']
        }
      }
    } catch (err) {
      cb.emit({
        type: 'error',
        runId,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

function resolveCwd(cwd: string): string {
  if (!cwd) return process.env['TERMINAL_CWD']?.trim() || process.cwd()
  return cwd
}

interface PromptParts {
  tools: { name: string; toolset: string }[]
  activeToolsets: Set<string>
  cwd: string
  model: string
  protocol: string
  memories: MemoryRow[]
  isCron?: boolean
  planGoal?: string
}

function buildSystemPrompt(parts: PromptParts): string {
  const blocks: string[] = []

  // ── Stable tier: SOUL.md identity (Hermes slot #1) ──────────────────
  const soul = loadSoul()
  if (soul) {
    blocks.push(soul)
  }

  // ── Plan mode (slot #1.5 — high priority, right after identity) ─────
  if (parts.planGoal) {
    blocks.push(
      '# Plan Mode\n' +
      '\n' +
      'You are currently in **Plan Mode** — a read-only exploration and design phase.\n' +
      'You must NOT edit, write, or modify any source files. Your tools are restricted\n' +
      'to read-only operations.\n' +
      '\n' +
      `**Plan goal:** ${parts.planGoal}\n` +
      '\n' +
      '## What you MUST do\n' +
      '- Explore the codebase to understand the current architecture, patterns, and constraints.\n' +
      '- Use read-only tools (`read_file`, `search_files`, `list_directory`, `WebSearch`) to research.\n' +
      '- Ask the user clarifying questions when requirements are ambiguous.\n' +
      '- Present design options with trade-offs for key decisions.\n' +
      '- Build a detailed, step-by-step implementation plan.\n' +
      '- Write the final plan to `plan.md` using the `exit_plan_mode` tool.\n' +
      '\n' +
      '## What you must NOT do\n' +
      '- **Do NOT edit source files.** You have no write tools available.\n' +
      '- **Do NOT execute terminal commands.** You are here to plan, not to build.\n' +
      '- **Do NOT implement anything.** Save that for after the plan is approved.\n' +
      '- **Do NOT skip the exploration phase.** Understand the codebase before designing.\n' +
      '\n' +
      '## Exit condition\n' +
      'When your plan is complete and written to `plan.md`, call the `exit_plan_mode` tool\n' +
      'to signal completion. The user will review and approve your plan before implementation\n' +
      'begins.\n' +
      '\n' +
      '## Important\n' +
      '- You share the same agentic loop as normal mode — the only difference is restricted tools\n' +
      '  and these planning instructions.\n' +
      '- The plan file is the primary deliverable. Make it thorough enough that someone else\n' +
      '  could implement from it without asking further questions.'
    )
  }

  // ── Cron mode: headless execution instructions (Hermes slot #2) ─────
  if (parts.isCron) {
    blocks.push(
      '# Cron / Scheduled Execution Mode\n' +
      '\n' +
      'You are running as an **automated scheduled (cron) job** — there is no human ' +
      'watching your output in real time. Your response will be saved to a file and, ' +
      'if a target session is configured, appended to that conversation.\n' +
      '\n' +
      '## Rules for cron execution\n' +
      '- **Execute the task directly.** Do NOT ask questions, seek clarification, or ' +
      'wait for a reply — no one will answer you.\n' +
      '- **Do not make small talk.** No greetings, no "Sure!", no "Let me help you with that." ' +
      'Just do the work and report results.\n' +
      '- **Be thorough.** You have up to 100 turns — use them to complete the task, ' +
      'not to chat.\n' +
      '- **Finish with a clear result.** End with a summary of what was done and ' +
      'whether it succeeded or failed.\n' +
      '- If you encounter an unrecoverable error, explain what went wrong and stop — ' +
      'do not loop retrying the same thing.\n' +
      '- If the task requires interactive input, note that limitation and do your best ' +
      'with what you have.'
    )
  }

  // ── Stable tier: model self-awareness ──────────────────────────────
  const protocolLabel = parts.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'
  blocks.push(
    `You are currently running on model: **${parts.model}** (protocol: ${protocolLabel}). ` +
    'You can mention this when asked "what model are you?" or "what LLM is this?". ' +
    'Do not make up capabilities — only claim what this model actually supports.'
  )

  // ── Stable tier: cross-session memories ──────────────────────────────
  if (parts.memories.length > 0) {
    blocks.push(memoryService.formatForPrompt(parts.memories))
  }

  // ── Stable tier: environment & tools context ───────────────────────
  blocks.push(
    `Working directory: ${parts.cwd}\nAll relative file paths resolve against this directory. Use absolute paths when uncertain.`
  )

  blocks.push(
    `Active toolsets: ${[...parts.activeToolsets].sort().join(', ')}.\nOnly tools whose toolset is in this list will be available to you this turn.`
  )

  // ── Stable tier: skills index (Hermes-style) ────────────────────────
  const toolNames = new Set(parts.tools.map((t) => t.name))
  blocks.push(buildSkillsIndex(toolNames, parts.activeToolsets))

  return blocks.join('\n\n')
}

export const agentService = new AgentService()

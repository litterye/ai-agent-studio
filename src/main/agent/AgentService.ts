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
    overrides?: { model?: string; protocol?: string; effort?: string; baseUrl?: string; visionMode?: string; apiKey?: string }
  ): Promise<void> {
    try {
      // Resolve model & protocol early — the system prompt needs them
      const settings = configStore.getSettings()
      const protocol = overrides?.protocol ?? settings.protocol
      const model = overrides?.model ?? settings.model

      // Resolve active toolsets for this session
      const approvals = getApprovalsConfig()
      const activeToolsets = new Set<string>(approvals.toolsets.default)
      // If the user pinned a session cwd, inject it into the system prompt
      const workspace = getWorkspaceConfig()
      const cwd = resolveCwd(workspace.sessions[sessionKey ?? ''] || workspace.defaultCwd)

      // Build tool list filtered by active toolsets
      const tools = await toolRegistry.forSession(activeToolsets)

      // Retrieve relevant cross-session memories
      const lastUserMsg = history.filter((m) => m.role === 'user').pop()?.content ?? ''
      const relevantMemories = memoryService.getRelevant(lastUserMsg, 5)

      const system = buildSystemPrompt({
        tools,
        activeToolsets,
        cwd,
        model,
        protocol,
        memories: relevantMemories
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
        sessionId: sessionId ?? undefined
      }

      // Side-channel so the terminal builtin (and any other tool that
      // resolves relative paths without receiving cwd directly) can find
      // the active cwd. Cleared after the run.
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
}

function buildSystemPrompt(parts: PromptParts): string {
  const blocks: string[] = []

  // ── Stable tier: SOUL.md identity (Hermes slot #1) ──────────────────
  const soul = loadSoul()
  if (soul) {
    blocks.push(soul)
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

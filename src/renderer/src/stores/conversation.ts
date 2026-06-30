import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentEvent, ChatMessage, MessageDTO, AttachmentMeta } from '@shared/ipc'
import { useSessionStore } from './sessions'

export interface ToolCallView {
  id: string
  name: string
  input: unknown
  status: 'running' | 'success' | 'error'
  result?: string
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface DisplayMessage {
  id: number // DB id (0 for in-flight assistant before DB insert)
  role: 'user' | 'assistant'
  text: string
  thinking: string
  toolCalls: ToolCallView[]
  attachments: AttachmentMeta[]
  streaming: boolean
  /** Tokens consumed by this assistant message (aggregated across all turns). */
  usage?: TokenUsage
}

function uid(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

/**
 * Metadata for an in-flight agent run.
 * Persisted across session switches so background runs can continue
 * accumulating state and writing to their session's DB.
 */
interface RunMeta {
  sessionId: string
  assistantMessageId: number
  text: string
  thinking: string
  toolCalls: ToolCallView[]
  usage?: TokenUsage
}

function freshMeta(sessionId: string, assistantMessageId: number): RunMeta {
  return { sessionId, assistantMessageId, text: '', thinking: '', toolCalls: [] }
}

export const useConversationStore = defineStore('conversation', () => {
  const messages = ref<DisplayMessage[]>([])
  const running = ref(false)
  const currentRunId = ref<string | null>(null)
  /** Total tokens consumed in the current session across all turns. */
  const sessionTokens = ref(0)
  let unsubscribe: (() => void) | null = null

  /** All in-flight runs across sessions. Keyed by runId. */
  const activeRuns = new Map<string, RunMeta>()

  // ── helpers to persist accumulated state to DB ───────────────────────

  function persistMeta(meta: RunMeta): void {
    if (meta.assistantMessageId <= 0) return
    void window.api.messages.update(meta.assistantMessageId, {
      content: meta.text,
      thinking: meta.thinking,
      toolCallsJson: JSON.stringify(toolCallsToJson(meta.toolCalls)),
      usageJson: meta.usage ? JSON.stringify(meta.usage) : undefined
    }).catch(() => {})
  }

  /** Apply an event to a RunMeta accumulator. Returns true if UI should also update. */
  function applyEvent(event: AgentEvent, meta: RunMeta): boolean {
    const isActive = event.runId === currentRunId.value
    const assistant = isActive ? messages.value[messages.value.length - 1] : null

    switch (event.type) {
      case 'text_delta':
        meta.text += event.text
        if (assistant && assistant.role === 'assistant') {
          assistant.text = meta.text
        }
        persistMeta(meta)
        break

      case 'thinking_delta':
        meta.thinking += event.text
        if (assistant && assistant.role === 'assistant') {
          assistant.thinking = meta.thinking
        }
        persistMeta(meta)
        break

      case 'tool_use':
        meta.toolCalls.push({
          id: event.id,
          name: event.toolName,
          input: event.input,
          status: 'running'
        })
        if (assistant && assistant.role === 'assistant') {
          assistant.toolCalls = [...meta.toolCalls]
        }
        persistMeta(meta)
        break

      case 'tool_result': {
        const tc = meta.toolCalls.find((t) => t.id === event.id)
        if (tc) {
          tc.status = event.isError ? 'error' : 'success'
          tc.result = event.content
        }
        if (assistant && assistant.role === 'assistant') {
          assistant.toolCalls = [...meta.toolCalls]
        }
        persistMeta(meta)
        break
      }

      case 'token_usage':
        if (!meta.usage) {
          meta.usage = { inputTokens: 0, outputTokens: 0 }
        }
        meta.usage.inputTokens += event.inputTokens
        meta.usage.outputTokens += event.outputTokens
        if (isActive) {
          sessionTokens.value += event.inputTokens + event.outputTokens
        }
        if (assistant && assistant.role === 'assistant') {
          assistant.usage = meta.usage ? { ...meta.usage } : undefined
        }
        break

      case 'done':
        if (event.finalText && !meta.text) meta.text = event.finalText
        if (assistant && assistant.role === 'assistant' && event.finalText && !assistant.text) {
          assistant.text = event.finalText
        }
        persistMeta(meta)
        activeRuns.delete(event.runId)
        if (isActive) finish()
        return false // already handled termination

      case 'error':
        meta.text += `\n\n[Error] ${event.message}`
        if (assistant && assistant.role === 'assistant') {
          assistant.text = meta.text
        }
        persistMeta(meta)
        activeRuns.delete(event.runId)
        if (isActive) finish()
        return false

      case 'cancelled':
        meta.text += meta.text ? '\n\n[Cancelled]' : '[Cancelled]'
        if (assistant && assistant.role === 'assistant') {
          assistant.text = meta.text
        }
        persistMeta(meta)
        activeRuns.delete(event.runId)
        if (isActive) finish()
        return false
    }
    return true
  }

  // ── public API ───────────────────────────────────────────────────────

  /** Load persisted messages for the active session. */
  async function loadSession(sessionId: string): Promise<void> {
    // Detach UI from the current run (but do NOT cancel it — the agent keeps
    // running and events continue to be persisted to the correct session's DB).
    running.value = false
    currentRunId.value = null

    messages.value = []
    sessionTokens.value = 0
    try {
      const rows: MessageDTO[] = await window.api.messages.load(sessionId)
      messages.value = rows.map(toDisplay)
      // Restore session total from saved messages
      for (const m of messages.value) {
        if (m.usage) sessionTokens.value += m.usage.inputTokens + m.usage.outputTokens
      }
    } catch (err) {
      console.error('[convo] load failed:', err)
    }

    // Check if this session has a background run still in flight —
    // re-attach the UI so streaming resumes in-place.
    for (const [runId, meta] of activeRuns) {
      if (meta.sessionId === sessionId) {
        currentRunId.value = runId
        running.value = true
        // Restore the assistant message from accumulated meta
        const lastMsg = messages.value[messages.value.length - 1]
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.text = meta.text
          lastMsg.thinking = meta.thinking
          lastMsg.toolCalls = [...meta.toolCalls]
          lastMsg.usage = meta.usage ? { ...meta.usage } : undefined
          lastMsg.streaming = true
        }
        break
      }
    }
  }

  /** History sent to the model: plain user/assistant text turns + attachments. */
  function buildHistory(): ChatMessage[] {
    return messages.value
      .filter((m) => m.text.trim().length > 0 || m.attachments.length > 0)
      .map((m) => ({
        role: m.role,
        content: m.text,
        ...(m.attachments.length > 0 ? { attachments: JSON.parse(JSON.stringify(m.attachments)) } : {})
      }))
  }

  function ensureSubscribed(): void {
    if (unsubscribe) return
    unsubscribe = window.api.agent.onEvent(handleEvent)
  }

  /**
   * Central event handler. All streaming events flow through here regardless
   * of which session they belong to:
   *  - Events from the active session update both the UI and the DB.
   *  - Events from background sessions accumulate state and persist to the
   *    correct session's DB, so no data is lost when switching back.
   */
  async function handleEvent(event: AgentEvent): Promise<void> {
    const meta = activeRuns.get(event.runId)
    if (!meta) return // unknown or already-finished run
    applyEvent(event, meta)
  }

  function finish(): void {
    const assistant = messages.value[messages.value.length - 1]
    if (assistant) assistant.streaming = false
    running.value = false
    currentRunId.value = null
  }

  async function send(text: string, attachments?: AttachmentMeta[]): Promise<void> {
    if (running.value || (!text.trim() && (!attachments || attachments.length === 0))) return

    const sessionStore = useSessionStore()
    const sessionId = sessionStore.activeSessionId
    if (!sessionId) return

    ensureSubscribed()

    const atts = attachments ?? []
    const attsJson = atts.length > 0 ? JSON.stringify(atts) : '[]'

    // Persist user message to DB
    const userRow = await window.api.messages.append({
      sessionId,
      role: 'user',
      content: text.trim(),
      attachmentsJson: attsJson
    }).catch(() => null)

    messages.value.push({
      id: userRow?.id ?? 0,
      role: 'user',
      text: text.trim(),
      thinking: '',
      toolCalls: [],
      attachments: atts,
      streaming: false
    })

    // Create in-flight assistant placeholder (id=0 until DB insert)
    const assistantRow = await window.api.messages.append({
      sessionId,
      role: 'assistant',
      content: ''
    }).catch(() => null)

    messages.value.push({
      id: assistantRow?.id ?? 0,
      role: 'assistant',
      text: '',
      thinking: '',
      toolCalls: [],
      attachments: [],
      streaming: true
    })

    const history = buildHistory()
    const runId = uid()
    currentRunId.value = runId
    running.value = true

    // Track this run so events are routed to the correct session even after
    // the user switches away.
    activeRuns.set(runId, freshMeta(sessionId, assistantRow?.id ?? 0))

    // Include sessionId so main process can look up model/protocol overrides
    window.api.agent.send({
      runId,
      messages: history,
      sessionKey: sessionId,
      sessionId
    })

    // Update session title from first user message if it's still default
    if (sessionStore.activeSession?.title === '新对话') {
      const title = text.trim().slice(0, 50) + (text.trim().length > 50 ? '…' : '')
      void sessionStore.update(sessionId, { title })
    }
  }

  function cancel(): void {
    if (currentRunId.value) window.api.agent.cancel(currentRunId.value)
  }

  async function clear(): Promise<void> {
    if (running.value) return
    const sessionStore = useSessionStore()
    const sessionId = sessionStore.activeSessionId
    if (sessionId) {
      await window.api.messages.clear(sessionId).catch(() => {})
    }
    messages.value = []
  }

  return { messages, running, sessionTokens, send, cancel, clear, loadSession }
})

// ─── helpers ────────────────────────────────────────────────────────────

function toDisplay(m: MessageDTO): DisplayMessage {
  let toolCalls: ToolCallView[] = []
  try {
    const parsed = JSON.parse(m.toolCallsJson || '[]')
    toolCalls = Array.isArray(parsed) ? parsed : []
  } catch { /* ignore */ }

  let attachments: AttachmentMeta[] = []
  try {
    const parsed = JSON.parse(m.attachmentsJson || '[]')
    attachments = Array.isArray(parsed) ? parsed : []
  } catch { /* ignore */ }

  let usage: TokenUsage | undefined
  try {
    const parsed = JSON.parse(m.usageJson || '{}')
    if (parsed.inputTokens > 0 || parsed.outputTokens > 0) {
      usage = parsed as TokenUsage
    }
  } catch { /* ignore */ }

  return {
    id: m.id,
    role: m.role,
    text: m.content,
    thinking: m.thinking,
    toolCalls,
    attachments,
    usage,
    streaming: false
  }
}

interface ToolCallJson {
  id: string; name: string; input: unknown; status: string; result?: string
}

function toolCallsToJson(tcs: ToolCallView[]): ToolCallJson[] {
  return tcs.map((tc) => ({
    id: tc.id,
    name: tc.name,
    input: tc.input,
    status: tc.status,
    ...(tc.result ? { result: tc.result } : {})
  }))
}

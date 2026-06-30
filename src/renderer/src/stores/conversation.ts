import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AgentEvent, ChatMessage, MessageDTO, AttachmentMeta, MemoryEvent } from '@shared/ipc'
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

export const useConversationStore = defineStore('conversation', () => {
  const messages = ref<DisplayMessage[]>([])
  const running = ref(false)
  const currentRunId = ref<string | null>(null)
  /** Total tokens consumed in the current session across all turns. */
  const sessionTokens = ref(0)
  /** Memory-related events like API errors (for display to user). */
  const memoryEvents = ref<MemoryEvent[]>([])
  let unsubscribe: (() => void) | null = null
  let memoryUnsubscribe: (() => void) | null = null

  /** Subscribe to memory events (model errors, etc.). */
  function ensureMemorySubscribed(): void {
    if (memoryUnsubscribe) return
    memoryUnsubscribe = window.api.memory.onError((event: MemoryEvent) => {
      // Add to list for display, keep last 10
      memoryEvents.value.push(event)
      if (memoryEvents.value.length > 10) {
        memoryEvents.value = memoryEvents.value.slice(-10)
      }
      // Also log to console for debugging
      console.warn('[memory] event:', event)
    })
  }

  /** Dismiss a specific memory event by index. */
  function dismissMemoryEvent(index: number): void {
    memoryEvents.value.splice(index, 1)
  }

  /** Clear all memory events. */
  function clearMemoryEvents(): void {
    memoryEvents.value = []
  }

  /** Load persisted messages for the active session. */
  async function loadSession(sessionId: string): Promise<void> {
    messages.value = []
    sessionTokens.value = 0
    // Subscribe to memory events for this session
    ensureMemorySubscribed()
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
  }

  /** History sent to the model: plain user/assistant text turns + attachments. */
  function buildHistory(): ChatMessage[] {
    return messages.value
      .filter((m) => m.text.trim().length > 0 || m.attachments.length > 0)
      .map((m) => ({
        role: m.role,
        content: m.text,
        // toRaw + spread (or JSON round-trip) are needed because Pinia wraps
        // the attachments array in a reactive Proxy which Electron's structured
        // clone cannot serialize.
        ...(m.attachments.length > 0 ? { attachments: JSON.parse(JSON.stringify(m.attachments)) } : {})
      }))
  }

  function ensureSubscribed(): void {
    if (unsubscribe) return
    unsubscribe = window.api.agent.onEvent(handleEvent)
  }

  async function handleEvent(event: AgentEvent): Promise<void> {
    if (event.runId !== currentRunId.value) return
    const assistant = messages.value[messages.value.length - 1]
    if (!assistant || assistant.role !== 'assistant') return

    switch (event.type) {
      case 'text_delta':
        assistant.text += event.text
        // Persist to DB if we have a stored id
        if (assistant.id > 0) {
          void window.api.messages.update(assistant.id, { content: assistant.text }).catch(() => {})
        }
        break
      case 'thinking_delta':
        assistant.thinking += event.text
        if (assistant.id > 0) {
          void window.api.messages.update(assistant.id, { thinking: assistant.thinking }).catch(() => {})
        }
        break
      case 'tool_use':
        assistant.toolCalls.push({
          id: event.id,
          name: event.toolName,
          input: event.input,
          status: 'running'
        })
        if (assistant.id > 0) {
          void window.api.messages.update(assistant.id, {
            toolCallsJson: JSON.stringify(toolCallsToJson(assistant.toolCalls))
          }).catch(() => {})
        }
        break
      case 'tool_result': {
        const tc = assistant.toolCalls.find((t) => t.id === event.id)
        if (tc) {
          tc.status = event.isError ? 'error' : 'success'
          tc.result = event.content
        }
        if (assistant.id > 0) {
          void window.api.messages.update(assistant.id, {
            toolCallsJson: JSON.stringify(toolCallsToJson(assistant.toolCalls))
          }).catch(() => {})
        }
        break
      }
      case 'token_usage':
        if (!assistant.usage) {
          assistant.usage = { inputTokens: 0, outputTokens: 0 }
        }
        assistant.usage.inputTokens += event.inputTokens
        assistant.usage.outputTokens += event.outputTokens
        sessionTokens.value += event.inputTokens + event.outputTokens
        break
      case 'done':
        if (event.finalText && !assistant.text) assistant.text = event.finalText
        if (assistant.id > 0) {
          void window.api.messages.update(assistant.id, {
            content: assistant.text,
            thinking: assistant.thinking,
            toolCallsJson: JSON.stringify(toolCallsToJson(assistant.toolCalls)),
            usageJson: assistant.usage ? JSON.stringify(assistant.usage) : undefined
          }).catch(() => {})
        }
        finish()
        break
      case 'error':
        assistant.text += `\n\n[Error] ${event.message}`
        finish()
        break
      case 'cancelled':
        assistant.text += assistant.text ? '\n\n[Cancelled]' : '[Cancelled]'
        finish()
        break
    }
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

  return { messages, running, sessionTokens, memoryEvents, send, cancel, clear, loadSession, dismissMemoryEvent, clearMemoryEvents }
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

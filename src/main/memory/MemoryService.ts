import type { ChatMessage, MemoryEntryDTO, MemoryEvent } from '@shared/ipc'
import type { MemoryRow } from '../db/memoryStore'
import { memoryStore } from '../db/memoryStore'
import { extractMemories, isModelError, type ModelError } from './extractor'

/** Emitter for memory events to UI. */
let memoryEventEmitter: ((event: MemoryEvent) => void) | null = null

/**
 * Set the memory event emitter. Call this once during app initialization.
 * The emitter will be used to send memory-related events (like API errors) to the UI.
 */
export function setMemoryEventEmitter(emitter: (event: MemoryEvent) => void): void {
  memoryEventEmitter = emitter
}

/** Emit a memory event to the UI if an emitter is registered. */
function emitMemoryEvent(event: MemoryEvent): void {
  if (memoryEventEmitter) {
    memoryEventEmitter(event)
  }
}

/**
 * Translate API error codes/messages to user-friendly display messages.
 */
function getDisplayMessage(error: ModelError): string {
  const { code, statusCode, message } = error

  // Rate limit errors
  if (statusCode === 429 || code === '0x04030020' || message.includes('频率') || message.includes('rate limit') || message.includes('qpm')) {
    return `模型 ${error.model || 'API'} 调用频率超限，请稍后重试`
  }

  // Auth errors
  if (statusCode === 401 || statusCode === 403 || code === 'authentication_error' || code === 'invalid_api_key') {
    return 'API 密钥无效或无权限，请检查设置中的 API Key'
  }

  // Network errors
  if (statusCode === 0 || code === 'ENOTFOUND' || code === 'ECONNREFUSED' || message.includes('network')) {
    return '网络连接失败，请检查网络和 API 地址设置'
  }

  // Server errors
  if (statusCode && statusCode >= 500) {
    return 'API 服务器错误，请稍后重试'
  }

  // Quota/billing errors
  if (code === 'insufficient_quota' || message.includes('quota') || message.includes('额度')) {
    return 'API 配额不足，请检查账户余额或升级套餐'
  }

  // Generic fallback with extracted message
  const shortMsg = message.length > 60 ? message.slice(0, 60) + '...' : message
  return `记忆提取失败: ${shortMsg}`
}

/**
 * Orchestrates memory retrieval (pre-run), format (system prompt injection),
 * and extraction+storage (post-run).
 */
export const memoryService = {
  /**
   * Find memories relevant to the user's latest input.
   * Touches each retrieved memory (bumps access_count).
   */
  getRelevant(userInput: string, limit = 5): MemoryRow[] {
    const results = memoryStore.search(userInput, limit)
    for (const m of results) {
      memoryStore.touch(m.id)
    }
    return results
  },

  /**
   * Fire-and-forget: extract memories from the last exchange and store them.
   * Called after the agent run completes.
   * apiKey/baseURL are passed from the RunContext so per-model keys work.
   */
  async extractAndStore(
    history: ChatMessage[],
    model: string,
    protocol: string,
    sessionId: string,
    apiKey?: string,
    baseURL?: string
  ): Promise<void> {
    try {
      const candidates = await extractMemories(history, model, protocol, apiKey, baseURL)

      // Check if it's a model API error
      if (isModelError(candidates)) {
        const error: ModelError = { ...candidates, model }
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        emitMemoryEvent({
          type: 'model_error',
          message: error.message,
          displayMessage: getDisplayMessage(error),
          model: error.model,
          timestamp
        })
        return
      }

      for (const c of candidates) {
        memoryStore.create({
          type: c.type,
          content: c.content,
          keywords: c.keywords,
          importance: c.importance,
          sourceSessionId: sessionId
        })
      }
      if (candidates.length > 0) {
        console.log(`[memory] stored ${candidates.length} new memories`)
      }
    } catch (err: unknown) {
      // Handle thrown model errors from extractor
      if (isModelError(err)) {
        const error: ModelError = { ...err, model }
        const timestamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
        emitMemoryEvent({
          type: 'model_error',
          message: error.message,
          displayMessage: getDisplayMessage(error),
          model: error.model,
          timestamp
        })
        return
      }
      console.error('[memory] extractAndStore error:', err)
    }
  },

  /**
   * Format a list of memories as an XML block for the system prompt.
   * Capped at ~1500 chars to not eat context window.
   */
  formatForPrompt(memories: MemoryRow[]): string {
    if (memories.length === 0) return ''

    const lines: string[] = ['<relevant_memories>']
    let totalChars = 0
    const MAX = 1500

    for (const m of memories) {
      const typeLabel = { fact: '事实', preference: '偏好', feedback: '反馈', learning: '学习' }[m.type]
      const line = `  - [${typeLabel}] ${m.content}`
      if (totalChars + line.length > MAX) break
      lines.push(line)
      totalChars += line.length
    }
    lines.push('</relevant_memories>')
    lines.push('You may reference these if relevant. Do not fabricate memories that are not listed.')

    return lines.join('\n')
  },

  /** All memories for the settings UI. */
  getAll(): MemoryEntryDTO[] {
    return memoryStore.list().map(toDTO)
  },

  /** Delete one memory by id. */
  remove(id: string): boolean {
    return memoryStore.remove(id)
  },

  /** Clear all memories. */
  clear(): void {
    memoryStore.clear()
  }
}

function toDTO(m: MemoryRow): MemoryEntryDTO {
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    keywords: m.keywords,
    importance: m.importance,
    sourceSessionId: m.source_session_id,
    accessCount: m.access_count,
    lastAccessedAt: m.last_accessed_at,
    createdAt: m.created_at,
    updatedAt: m.updated_at
  }
}

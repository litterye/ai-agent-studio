import type { ChatMessage, MemoryEntryDTO } from '@shared/ipc'
import type { MemoryRow } from '../db/memoryStore'
import { memoryStore } from '../db/memoryStore'
import { extractMemories } from './extractor'

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
   */
  async extractAndStore(
    history: ChatMessage[],
    model: string,
    protocol: string,
    sessionId: string
  ): Promise<void> {
    try {
      const candidates = await extractMemories(history, model, protocol)
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
    } catch (err) {
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

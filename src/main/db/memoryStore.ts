import { randomUUID } from 'crypto'
import { run, all, get, persist } from './database'

export interface MemoryRow {
  id: string
  type: 'fact' | 'preference' | 'feedback' | 'learning'
  content: string
  keywords: string
  importance: number
  source_session_id: string
  access_count: number
  last_accessed_at: string | null
  created_at: string
  updated_at: string
}

const now = (): string => new Date().toISOString()

export const memoryStore = {
  list(): MemoryRow[] {
    return all<MemoryRow>(
      'SELECT * FROM memories ORDER BY created_at DESC'
    )
  },

  getById(id: string): MemoryRow | undefined {
    return get<MemoryRow>('SELECT * FROM memories WHERE id = ?', [id])
  },

  create(mem: {
    type: 'fact' | 'preference' | 'feedback' | 'learning'
    content: string
    keywords?: string
    importance?: number
    sourceSessionId?: string
  }): MemoryRow {
    const id = randomUUID()
    const ts = now()
    run(
      `INSERT INTO memories (id, type, content, keywords, importance, source_session_id, access_count, last_accessed_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,0,NULL,?,?)`,
      [
        id,
        mem.type,
        mem.content,
        mem.keywords ?? '',
        mem.importance ?? 5,
        mem.sourceSessionId ?? '',
        ts,
        ts
      ]
    )
    persist()
    return {
      id,
      type: mem.type,
      content: mem.content,
      keywords: mem.keywords ?? '',
      importance: mem.importance ?? 5,
      source_session_id: mem.sourceSessionId ?? '',
      access_count: 0,
      last_accessed_at: null,
      created_at: ts,
      updated_at: ts
    }
  },

  /**
   * Record an access hit — bumps access_count and last_accessed_at.
   * Called when a memory is retrieved and injected into a prompt.
   */
  touch(id: string): void {
    run(
      `UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?`,
      [now(), id]
    )
    persist()
  },

  remove(id: string): boolean {
    const before = get<MemoryRow>('SELECT id FROM memories WHERE id = ?', [id])
    if (!before) return false
    run('DELETE FROM memories WHERE id = ?', [id])
    persist()
    return true
  },

  clear(): void {
    run('DELETE FROM memories')
    persist()
  },

  /**
   * Keyword-based search with relevance scoring.
   *
   * Scoring formula: Σ(keyword match count) × importance × recencyBoost
   * - Each keyword that appears in content or keywords column scores 1 point
   * - Multiplied by importance (1-10)
   * - ×2 if accessed within the last 7 days (recency boost)
   * Results sorted by score DESC, capped at `limit`.
   */
  search(query: string, limit = 5): MemoryRow[] {
    const allMemories = this.list()
    if (!query.trim() || allMemories.length === 0) {
      // Return most important + recent when no query
      return allMemories
        .sort((a, b) => b.importance - a.importance || b.created_at.localeCompare(a.created_at))
        .slice(0, limit)
    }

    const q = query.toLowerCase()
    // Split into tokens — Chinese: character-level; English: word-level
    const tokens = tokenize(q)

    const scored = allMemories.map((m) => {
      let matches = 0
      const haystack = (m.content + ' ' + m.keywords).toLowerCase()
      for (const t of tokens) {
        if (haystack.includes(t)) matches++
      }
      if (matches === 0) return { memory: m, score: 0 }

      // Importance factor (1-10)
      const imp = m.importance

      // Recency bonus: ×2 if accessed in last 7 days
      let recency = 1
      if (m.last_accessed_at) {
        const daysSince = (Date.now() - new Date(m.last_accessed_at).getTime()) / (1000 * 60 * 60 * 24)
        if (daysSince < 7) recency = 2
      } else {
        // Never accessed: slight bonus for freshness (created in last 7 days)
        const daysSinceCreated = (Date.now() - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24)
        if (daysSinceCreated < 7) recency = 1.5
      }

      const score = matches * imp * recency
      return { memory: m, score }
    })

    return scored
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.memory)
  },

  /** Check if a very similar memory already exists (simple substring overlap). */
  existsSimilar(content: string, threshold = 0.6): boolean {
    const allMemories = this.list()
    const norm = content.toLowerCase().trim()
    if (norm.length < 10) return false
    for (const m of allMemories) {
      const existing = m.content.toLowerCase().trim()
      // Quick substring check: if one contains the other
      if (existing.includes(norm) || norm.includes(existing)) return true
      // Character overlap ratio
      const overlap = [...norm].filter((c) => existing.includes(c)).length
      if (overlap / Math.max(norm.length, existing.length) > threshold) return true
    }
    return false
  }
}

/**
 * Simple tokenizer: splits on whitespace/punctuation for English,
 * extracts CJK character bigrams for Chinese/Japanese.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = []

  // Extract English/word tokens (non-CJK)
  const wordTokens = text.match(/[a-z0-9_]+/gi) ?? []
  for (const w of wordTokens) {
    if (w.length >= 2) tokens.push(w.toLowerCase())
  }

  // Extract CJK bigrams (character pairs)
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) ?? []
  for (let i = 0; i < cjk.length - 1; i++) {
    tokens.push(cjk[i] + cjk[i + 1])
  }
  // Also include single CJK chars for better matching
  for (const c of cjk) {
    if (c.length === 1) tokens.push(c)
  }

  return [...new Set(tokens)]
}

import { run, all, get, persist } from './database'

export interface MessageRow {
  id: number
  session_id: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  tool_calls_json: string
  attachments_json: string
  created_at: string
}

const now = (): string => new Date().toISOString()

export const messageStore = {
  listBySession(sessionId: string): MessageRow[] {
    return all<MessageRow>(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC',
      [sessionId]
    )
  },

  /** Append a message and return it with the assigned id. */
  append(msg: {
    sessionId: string
    role: 'user' | 'assistant'
    content?: string
    thinking?: string
    toolCallsJson?: string
    attachmentsJson?: string
  }): MessageRow {
    const ts = now()
    run(
      `INSERT INTO messages (session_id, role, content, thinking, tool_calls_json, attachments_json, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      [msg.sessionId, msg.role, msg.content ?? '', msg.thinking ?? '', msg.toolCallsJson ?? '[]', msg.attachmentsJson ?? '[]', ts]
    )
    // sql.js lastInsertRowId
    const db = get<{ id: number }>('SELECT last_insert_rowid() as id')
    persist()
    return {
      id: db?.id ?? 0,
      session_id: msg.sessionId,
      role: msg.role,
      content: msg.content ?? '',
      thinking: msg.thinking ?? '',
      tool_calls_json: msg.toolCallsJson ?? '[]',
      attachments_json: msg.attachmentsJson ?? '[]',
      created_at: ts
    }
  },

  /** Update an assistant message — called during streaming to keep DB in sync. */
  update(id: number, patch: {
    content?: string
    thinking?: string
    toolCallsJson?: string
    attachmentsJson?: string
  }): void {
    const existing = get<MessageRow>('SELECT * FROM messages WHERE id = ?', [id])
    if (!existing) return
    run(
      `UPDATE messages SET content=?, thinking=?, tool_calls_json=?, attachments_json=? WHERE id=?`,
      [
        patch.content ?? existing.content,
        patch.thinking ?? existing.thinking,
        patch.toolCallsJson ?? existing.tool_calls_json,
        patch.attachmentsJson ?? existing.attachments_json,
        id
      ]
    )
    persist()
  },

  clearBySession(sessionId: string): void {
    run('DELETE FROM messages WHERE session_id = ?', [sessionId])
    persist()
  }
}

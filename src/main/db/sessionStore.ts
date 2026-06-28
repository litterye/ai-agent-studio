import { randomUUID } from 'crypto'
import { run, all, get, persist } from './database'

export interface SessionRow {
  id: string
  agent_id: string
  title: string
  model: string
  protocol: string
  effort: string
  base_url: string
  created_at: string
  updated_at: string
}

const now = (): string => new Date().toISOString()

export const sessionStore = {
  listByAgent(agentId: string): SessionRow[] {
    return all<SessionRow>('SELECT * FROM sessions WHERE agent_id = ? ORDER BY updated_at DESC', [agentId])
  },

  getById(id: string): SessionRow | undefined {
    return get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id])
  },

  create(input: {
    agentId: string
    title?: string
    model?: string
    protocol?: string
    effort?: string
    baseUrl?: string
  }): SessionRow {
    const ts = now()
    const row: SessionRow = {
      id: randomUUID(),
      agent_id: input.agentId,
      title: input.title ?? '新对话',
      model: input.model ?? 'claude-sonnet-4-6',
      protocol: input.protocol ?? 'anthropic',
      effort: input.effort ?? 'medium',
      base_url: input.baseUrl ?? '',
      created_at: ts,
      updated_at: ts
    }
    run(
      `INSERT INTO sessions (id,agent_id,title,model,protocol,effort,base_url,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [row.id, row.agent_id, row.title, row.model, row.protocol, row.effort, row.base_url, row.created_at, row.updated_at]
    )
    persist()
    return row
  },

  update(id: string, patch: {
    title?: string
    model?: string
    protocol?: string
    effort?: string
    baseUrl?: string
  }): SessionRow | undefined {
    const existing = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id])
    if (!existing) return undefined

    const updated: SessionRow = {
      ...existing,
      title: patch.title ?? existing.title,
      model: patch.model ?? existing.model,
      protocol: patch.protocol ?? existing.protocol,
      effort: patch.effort ?? existing.effort,
      base_url: patch.baseUrl ?? existing.base_url,
      updated_at: now()
    }
    run(
      `UPDATE sessions SET title=?, model=?, protocol=?, effort=?, base_url=?, updated_at=? WHERE id=?`,
      [updated.title, updated.model, updated.protocol, updated.effort, updated.base_url, updated.updated_at, id]
    )
    persist()
    return updated
  },

  remove(id: string): boolean {
    const existing = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [id])
    if (!existing) return false
    run('DELETE FROM messages WHERE session_id = ?', [id])
    run('DELETE FROM sessions WHERE id = ?', [id])
    persist()
    return true
  },

  countByAgent(agentId: string): number {
    const row = get<{ c: number }>('SELECT COUNT(*) as c FROM sessions WHERE agent_id = ?', [agentId])
    return row?.c ?? 0
  },

  countMessages(sessionId: string): number {
    const row = get<{ c: number }>('SELECT COUNT(*) as c FROM messages WHERE session_id = ?', [sessionId])
    return row?.c ?? 0
  }
}

import { randomUUID } from 'crypto'
import { join } from 'path'
import { run, all, get, persist } from './database'
import { paths } from '../approvals/paths'

export interface AgentRow {
  id: string
  name: string
  description: string
  workspace_dir: string
  default_model: string
  default_protocol: string
  created_at: string
  updated_at: string
}

const now = (): string => new Date().toISOString()

export const agentStore = {
  list(): AgentRow[] {
    return all<AgentRow>('SELECT * FROM agents ORDER BY created_at ASC')
  },

  getById(id: string): AgentRow | undefined {
    return get<AgentRow>('SELECT * FROM agents WHERE id = ?', [id])
  },

  create(input: {
    name: string
    description?: string
    workspaceDir?: string
    defaultModel?: string
    defaultProtocol?: string
  }): AgentRow {
    const ts = now()
    const row: AgentRow = {
      id: randomUUID(),
      name: input.name.trim(),
      description: input.description ?? '',
      workspace_dir: input.workspaceDir ?? join(paths.home, 'workspace', input.name.trim()),
      default_model: input.defaultModel ?? 'claude-sonnet-4-6',
      default_protocol: input.defaultProtocol ?? 'anthropic',
      created_at: ts,
      updated_at: ts
    }
    run(
      `INSERT INTO agents (id,name,description,workspace_dir,default_model,default_protocol,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [row.id, row.name, row.description, row.workspace_dir, row.default_model, row.default_protocol, row.created_at, row.updated_at]
    )
    persist()
    return row
  },

  update(id: string, patch: {
    name?: string
    description?: string
    workspaceDir?: string
    defaultModel?: string
    defaultProtocol?: string
  }): AgentRow | undefined {
    const existing = get<AgentRow>('SELECT * FROM agents WHERE id = ?', [id])
    if (!existing) return undefined

    const updated: AgentRow = {
      ...existing,
      name: patch.name ?? existing.name,
      description: patch.description ?? existing.description,
      workspace_dir: patch.workspaceDir ?? existing.workspace_dir,
      default_model: patch.defaultModel ?? existing.default_model,
      default_protocol: patch.defaultProtocol ?? existing.default_protocol,
      updated_at: now()
    }
    run(
      `UPDATE agents SET name=?, description=?, workspace_dir=?, default_model=?, default_protocol=?, updated_at=? WHERE id=?`,
      [updated.name, updated.description, updated.workspace_dir, updated.default_model, updated.default_protocol, updated.updated_at, id]
    )
    persist()
    return updated
  },

  remove(id: string): boolean {
    const existing = get<AgentRow>('SELECT * FROM agents WHERE id = ?', [id])
    if (!existing) return false
    // Cascade-delete sessions and messages (FK handles sessions; messages refer to sessions)
    const sessions = all<{ id: string }>('SELECT id FROM sessions WHERE agent_id = ?', [id])
    for (const s of sessions) {
      run('DELETE FROM messages WHERE session_id = ?', [s.id])
    }
    run('DELETE FROM sessions WHERE agent_id = ?', [id])
    run('DELETE FROM agents WHERE id = ?', [id])
    persist()
    return true
  },

  /** Return the first agent, or auto-create a default one on first launch. */
  getDefault(): AgentRow {
    const list = this.list()
    if (list.length > 0) return list[0]
    return this.create({
      name: 'Default',
      description: 'Auto-created default agent'
    })
  }
}

import { randomUUID } from 'crypto'
import { safeStorage } from 'electron'
import { run, all, get, persist } from './database'

export interface ModelRow {
  id: string
  name: string
  protocol: 'anthropic' | 'openai'
  base_url: string
  model_id: string
  api_key_encrypted: string
  vision_mode: string
  created_at: string
  updated_at: string
}

export interface ModelCreateInput {
  name: string
  protocol: 'anthropic' | 'openai'
  baseUrl?: string
  modelId: string
  apiKey?: string
  visionMode?: string
}

export interface ModelUpdatePatch {
  name?: string
  protocol?: 'anthropic' | 'openai'
  baseUrl?: string
  modelId?: string
  /** Empty string = clear key; omit = don't change. */
  apiKey?: string
  visionMode?: string
}

function encryptKey(plain: string): string {
  if (!plain || !safeStorage.isEncryptionAvailable()) return ''
  return safeStorage.encryptString(plain).toString('base64')
}

function decryptKey(encrypted: string): string | null {
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  } catch {
    return null
  }
}

export const modelStore = {
  list(): ModelRow[] {
    return all<ModelRow>('SELECT * FROM models ORDER BY created_at DESC')
  },

  getById(id: string): ModelRow | undefined {
    return get<ModelRow>('SELECT * FROM models WHERE id = ?', [id])
  },

  /** Resolve the plaintext API key for a model. Returns null if not set or unavailable. */
  resolveApiKey(id: string): string | null {
    const row = get<Pick<ModelRow, 'api_key_encrypted'>>(
      'SELECT api_key_encrypted FROM models WHERE id = ?',
      [id]
    )
    if (!row) return null
    return decryptKey(row.api_key_encrypted)
  },

  create(input: ModelCreateInput): ModelRow {
    const id = randomUUID()
    const now = new Date().toISOString()
    const encrypted = encryptKey(input.apiKey ?? '')
    const visionMode = input.visionMode ?? 'text'
    run(
      `INSERT INTO models (id, name, protocol, base_url, model_id, api_key_encrypted, vision_mode, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.name, input.protocol, input.baseUrl ?? '', input.modelId, encrypted, visionMode, now, now]
    )
    persist()
    return this.getById(id)!
  },

  update(id: string, patch: ModelUpdatePatch): ModelRow | undefined {
    const existing = this.getById(id)
    if (!existing) return undefined

    const now = new Date().toISOString()
    const sets: string[] = ['updated_at = ?']
    const params: unknown[] = [now]

    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name) }
    if (patch.protocol !== undefined) { sets.push('protocol = ?'); params.push(patch.protocol) }
    if (patch.baseUrl !== undefined) { sets.push('base_url = ?'); params.push(patch.baseUrl) }
    if (patch.modelId !== undefined) { sets.push('model_id = ?'); params.push(patch.modelId) }
    if (patch.apiKey !== undefined) {
      sets.push('api_key_encrypted = ?')
      params.push(encryptKey(patch.apiKey))
    }
    if (patch.visionMode !== undefined) { sets.push('vision_mode = ?'); params.push(patch.visionMode) }

    params.push(id)
    run(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`, params)
    persist()
    return this.getById(id)
  },

  remove(id: string): boolean {
    const existing = this.getById(id)
    if (!existing) return false
    run('DELETE FROM models WHERE id = ?', [id])
    persist()
    return true
  },

  /** Return the first model (by creation order), or undefined if none exist. */
  getDefault(): ModelRow | undefined {
    return get<ModelRow>('SELECT * FROM models ORDER BY created_at ASC LIMIT 1')
  },

  /** Find a model by its modelId (e.g. "claude-opus-4-8"). */
  getByModelId(modelId: string): ModelRow | undefined {
    return get<ModelRow>('SELECT * FROM models WHERE model_id = ?', [modelId])
  }
}

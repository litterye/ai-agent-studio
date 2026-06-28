import { safeStorage, app } from 'electron'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { ProviderSettings, KeyStatus, Protocol, AppSettings } from '@shared/ipc'

interface PersistedState {
  settings: ProviderSettings
  keys: Partial<Record<Protocol, string>>
  appSettings: AppSettings
}

const DEFAULT_SETTINGS: ProviderSettings = {
  protocol: 'anthropic',
  baseUrl: '',
  model: 'claude-opus-4-8',
  effort: 'high'
}

const DEFAULT_APP_SETTINGS: AppSettings = {
  theme: 'dark',
  language: 'zh-CN'
}

/**
 * Holds provider settings + per-protocol API keys in the MAIN process only.
 * Keys are never sent to the renderer.
 * Key resolution per protocol: env var (ANTHROPIC_API_KEY / OPENAI_API_KEY) > stored key.
 */
class ConfigStore {
  private settings: ProviderSettings = { ...DEFAULT_SETTINGS }
  private keys: Partial<Record<Protocol, string>> = {}
  private appSettings: AppSettings = { ...DEFAULT_APP_SETTINGS }

  private get stateFile(): string {
    return join(app.getPath('userData'), 'provider.bin')
  }

  init(): void {
    try {
      if (existsSync(this.stateFile) && safeStorage.isEncryptionAvailable()) {
        const json = safeStorage.decryptString(readFileSync(this.stateFile))
        const parsed = JSON.parse(json) as PersistedState
        if (parsed.settings) this.settings = { ...DEFAULT_SETTINGS, ...parsed.settings }
        if (parsed.keys) this.keys = parsed.keys
        if (parsed.appSettings) this.appSettings = { ...DEFAULT_APP_SETTINGS, ...parsed.appSettings }
      }
    } catch {
      this.settings = { ...DEFAULT_SETTINGS }
      this.keys = {}
      this.appSettings = { ...DEFAULT_APP_SETTINGS }
    }
  }

  private persist(): void {
    try {
      if (!safeStorage.isEncryptionAvailable()) return
      const state: PersistedState = { settings: this.settings, keys: this.keys, appSettings: this.appSettings }
      writeFileSync(this.stateFile, safeStorage.encryptString(JSON.stringify(state)))
    } catch {
      /* keep in-memory even if disk write fails */
    }
  }

  getAppSettings(): AppSettings {
    return { ...this.appSettings }
  }

  setAppSettings(next: Partial<AppSettings>): AppSettings {
    this.appSettings = { ...this.appSettings, ...next }
    this.persist()
    return this.getAppSettings()
  }

  getSettings(): ProviderSettings {
    return { ...this.settings }
  }

  setSettings(next: Partial<ProviderSettings>): ProviderSettings {
    this.settings = { ...this.settings, ...next }
    this.persist()
    return this.getSettings()
  }

  private envKey(protocol: Protocol): string | null {
    const name = protocol === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'
    return process.env[name]?.trim() || null
  }

  /** Resolved key for the active protocol (env wins). Returns null if none. */
  resolveKey(): string | null {
    const p = this.settings.protocol
    return this.envKey(p) || this.keys[p] || null
  }

  /** Resolved base URL for the active protocol, or null to use the SDK default. */
  resolveBaseUrl(): string | null {
    const url = this.settings.baseUrl.trim()
    return url.length ? url : null
  }

  keyStatus(): KeyStatus {
    const p = this.settings.protocol
    if (this.envKey(p)) return { hasKey: true, source: 'env' }
    if (this.keys[p]) return { hasKey: true, source: 'stored' }
    return { hasKey: false, source: 'none' }
  }

  /** Persist a user-supplied key for the active protocol. Empty string clears it. */
  setKey(key: string): KeyStatus {
    const p = this.settings.protocol
    const trimmed = key.trim()
    if (!trimmed) {
      delete this.keys[p]
    } else {
      this.keys[p] = trimmed
    }
    this.persist()
    return this.keyStatus()
  }
}

export const configStore = new ConfigStore()

/**
 * Boundary: encrypted secrets live in Electron's userData via safeStorage.
 * The ~/.ai-agent-studio/ tree is plain text (approvals.yaml, workspace.json,
 * jobs.json, SKILL.md, etc). These helpers give the rest of the codebase a
 * single place to resolve those paths.
 *
 * Re-exported here so callers can `import { studioPaths } from '@main/config/store'`
 * alongside the existing config store, without adding a second import line.
 */
export { paths as studioPaths } from '../approvals/paths'

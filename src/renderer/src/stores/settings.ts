import { defineStore } from 'pinia'
import { ref } from 'vue'
import type { AppSettings, KeyStatus, ProviderSettings } from '@shared/ipc'

export const useSettingsStore = defineStore('settings', () => {
  const settings = ref<ProviderSettings>({
    protocol: 'anthropic',
    baseUrl: '',
    model: 'claude-opus-4-8',
    effort: 'high'
  })
  const keyStatus = ref<KeyStatus>({ hasKey: false, source: 'none' })
  const appSettings = ref<AppSettings>({ theme: 'dark', language: 'zh-CN' })

  async function load(): Promise<void> {
    settings.value = await window.api.settings.get()
    keyStatus.value = await window.api.key.status()
    try {
      appSettings.value = await window.api.appSettings.get()
    } catch {
      // Pre-upgrade compatibility — app settings may not exist yet
    }
  }

  async function save(next: Partial<ProviderSettings>): Promise<void> {
    settings.value = await window.api.settings.set(next)
    // Key status depends on the active protocol, so refresh it after a save.
    keyStatus.value = await window.api.key.status()
  }

  async function setKey(key: string): Promise<void> {
    keyStatus.value = await window.api.key.set(key)
  }

  async function setAppSettings(next: Partial<AppSettings>): Promise<void> {
    appSettings.value = await window.api.appSettings.set(next)
  }

  return { settings, keyStatus, appSettings, load, save, setKey, setAppSettings }
})

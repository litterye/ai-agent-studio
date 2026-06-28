import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { SessionDTO } from '@shared/ipc'

export const useSessionStore = defineStore('sessions', () => {
  const sessions = ref<SessionDTO[]>([])
  const activeSessionId = ref<string | null>(null)
  const loading = ref(false)

  const activeSession = computed(() =>
    sessions.value.find(s => s.id === activeSessionId.value) ?? null
  )

  async function load(agentId: string): Promise<void> {
    loading.value = true
    try {
      sessions.value = await window.api.sessions.list(agentId)
    } finally {
      loading.value = false
    }
  }

  async function create(input: {
    agentId: string; title?: string; model?: string; protocol?: string; effort?: string; baseUrl?: string
  }): Promise<SessionDTO> {
    const s = await window.api.sessions.create(input)
    sessions.value = [s, ...sessions.value]
    activeSessionId.value = s.id
    return s
  }

  async function update(id: string, patch: {
    title?: string; model?: string; protocol?: string; effort?: string; baseUrl?: string
  }): Promise<void> {
    const updated = await window.api.sessions.update(id, patch)
    if (updated) {
      sessions.value = sessions.value.map(s => s.id === id ? updated : s)
    }
  }

  async function remove(id: string): Promise<void> {
    await window.api.sessions.delete(id)
    sessions.value = sessions.value.filter(s => s.id !== id)
    if (activeSessionId.value === id) {
      activeSessionId.value = sessions.value[0]?.id ?? null
    }
  }

  function select(id: string): void {
    activeSessionId.value = id
  }

  return { sessions, activeSessionId, activeSession, loading, load, create, update, remove, select }
})

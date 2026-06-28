import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { AgentDTO } from '@shared/ipc'

export const useAgentStore = defineStore('agents', () => {
  const agents = ref<AgentDTO[]>([])
  const activeAgentId = ref<string | null>(null)
  const loading = ref(false)

  const activeAgent = computed(() =>
    agents.value.find(a => a.id === activeAgentId.value) ?? null
  )

  async function load(): Promise<void> {
    loading.value = true
    try {
      agents.value = await window.api.agents.list()
      if (agents.value.length > 0 && !activeAgentId.value) {
        activeAgentId.value = agents.value[0].id
      }
    } finally {
      loading.value = false
    }
  }

  async function create(input: {
    name: string; description?: string; workspaceDir?: string
    defaultModel?: string; defaultProtocol?: string
  }): Promise<AgentDTO> {
    const a = await window.api.agents.create(input)
    agents.value = [...agents.value, a]
    if (!activeAgentId.value) activeAgentId.value = a.id
    return a
  }

  async function update(id: string, patch: {
    name?: string; description?: string; workspaceDir?: string
    defaultModel?: string; defaultProtocol?: string
  }): Promise<void> {
    const updated = await window.api.agents.update(id, patch)
    if (updated) {
      agents.value = agents.value.map(a => a.id === id ? updated : a)
    }
  }

  async function remove(id: string): Promise<void> {
    await window.api.agents.delete(id)
    agents.value = agents.value.filter(a => a.id !== id)
    if (activeAgentId.value === id) {
      activeAgentId.value = agents.value[0]?.id ?? null
    }
  }

  function select(id: string): void {
    activeAgentId.value = id
  }

  return { agents, activeAgentId, activeAgent, loading, load, create, update, remove, select }
})

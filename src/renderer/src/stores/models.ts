import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ModelConfigDTO } from '@shared/ipc'

/**
 * Read-only store mirroring the models table in the main process.
 * ChatView and AgentDialog use this to build dropdown options.
 */
export const useModelStore = defineStore('models', () => {
  const items = ref<ModelConfigDTO[]>([])
  const loaded = ref(false)

  const options = computed(() =>
    items.value.map(m => ({
      label: m.name,
      value: m.modelId
    }))
  )

  /** modelId of the first model, or empty string if none configured. */
  const defaultModelId = computed(() =>
    items.value.length > 0 ? items.value[0].modelId : ''
  )

  /** The first model's protocol, or empty string if none configured. */
  const defaultProtocol = computed<string>(() =>
    items.value.length > 0 ? items.value[0].protocol : ''
  )

  async function load(): Promise<void> {
    items.value = await window.api.models.list()
    loaded.value = true
  }

  function getByModelId(modelId: string): ModelConfigDTO | undefined {
    return items.value.find(m => m.modelId === modelId)
  }

  return { items, options, defaultModelId, defaultProtocol, loaded, load, getByModelId }
})

<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { NModal, NForm, NFormItem, NInput, NSelect, NButton, NSpace, NInputGroup } from 'naive-ui'
import { useAgentStore } from '../stores/agents'
import { useModelStore } from '../stores/models'
import ModelDialog from './ModelDialog.vue'

const props = defineProps<{ agentId: string | null }>()
const emit = defineEmits<{ saved: [id: string]; cancel: [] }>()

const agentStore = useAgentStore()
const modelStore = useModelStore()
const saving = ref(false)
const errorMsg = ref('')
const showModelDialog = ref(false)
const workspaceBase = ref('')

const form = ref({
  name: '',
  description: '',
  workspaceDir: '',
  defaultModel: '',
  defaultProtocol: '' as 'anthropic' | 'openai'
})

const hasModels = computed(() => modelStore.options.length > 0)

const modelOptions = computed(() =>
  modelStore.options.length > 0
    ? modelStore.options
    : []
)

// Readable default workspace path: ~/.ai-agent-studio/workspace/<name>
const suggestedWorkspace = computed(() => {
  if (!workspaceBase.value || !form.value.name.trim()) return ''
  return `${workspaceBase.value}\\${form.value.name.trim()}`
})

onMounted(async () => {
  // Fetch workspace base dir for the placeholder
  try {
    workspaceBase.value = await window.api.app.getWorkspaceBase()
  } catch { /* ignore */ }

  if (props.agentId) {
    const a = await window.api.agents.get(props.agentId)
    if (a) {
      form.value = {
        name: a.name,
        description: a.description,
        workspaceDir: a.workspaceDir,
        defaultModel: a.defaultModel,
        defaultProtocol: a.defaultProtocol as 'anthropic' | 'openai'
      }
    }
  } else {
    // New agent: default to first model if available
    if (modelStore.items.length > 0) {
      const first = modelStore.items[0]
      form.value.defaultModel = first.modelId
      form.value.defaultProtocol = first.protocol
    }
    // workspaceDir starts empty — main process will compute default from name
  }
})

function onModelChange(modelId: string): void {
  const m = modelStore.getByModelId(modelId)
  if (m) {
    form.value.defaultProtocol = m.protocol
  }
}

async function pickWorkspace(): Promise<void> {
  const dir = await window.api.dialog.openDirectory()
  if (dir) {
    form.value.workspaceDir = dir
  }
}

async function onModelSaved(modelId: string): Promise<void> {
  showModelDialog.value = false
  await modelStore.load()
  // Auto-select the newly added model
  if (modelStore.items.length > 0) {
    const m = modelStore.items.find(x => x.id === modelId)
    if (m) {
      form.value.defaultModel = m.modelId
      form.value.defaultProtocol = m.protocol
    } else {
      // Fallback to first
      form.value.defaultModel = modelStore.items[0].modelId
      form.value.defaultProtocol = modelStore.items[0].protocol
    }
  }
}

async function save(): Promise<void> {
  if (!form.value.name.trim()) {
    errorMsg.value = '请输入智能体名称'
    return
  }
  saving.value = true
  errorMsg.value = ''
  try {
    if (props.agentId) {
      await agentStore.update(props.agentId, {
        name: form.value.name,
        description: form.value.description,
        workspaceDir: form.value.workspaceDir,
        defaultModel: form.value.defaultModel,
        defaultProtocol: form.value.defaultProtocol
      })
      emit('saved', props.agentId)
    } else {
      const a = await agentStore.create({
        name: form.value.name,
        description: form.value.description,
        workspaceDir: form.value.workspaceDir || undefined,
        defaultModel: form.value.defaultModel || undefined,
        defaultProtocol: form.value.defaultProtocol || undefined
      })
      emit('saved', a.id)
    }
  } catch (err) {
    errorMsg.value = String(err)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    :title="props.agentId ? '编辑智能体' : '新建智能体'"
    style="width: 520px; max-width: 94vw"
    :mask-closable="false"
    @update:show="(v) => { if (!v) emit('cancel') }"
  >
    <NForm :model="form">
      <NFormItem label="名称" required>
        <NInput v-model:value="form.name" placeholder="例如：代码助手" />
      </NFormItem>
      <NFormItem label="描述">
        <NInput v-model:value="form.description" placeholder="智能体的用途（可选）" />
      </NFormItem>
      <NFormItem label="工作目录">
        <NInputGroup>
          <NInput
            v-model:value="form.workspaceDir"
            :placeholder="suggestedWorkspace || '选择或使用默认工作目录'"
            readonly
          />
          <NButton @click="pickWorkspace" title="选择目录">
            📁
          </NButton>
        </NInputGroup>
      </NFormItem>
      <NFormItem label="默认模型">
        <template v-if="hasModels">
          <NSelect
            v-model:value="form.defaultModel"
            :options="modelOptions"
            @update:value="onModelChange"
          />
        </template>
        <template v-else>
          <NButton size="small" type="primary" @click="showModelDialog = true">
            添加模型
          </NButton>
        </template>
      </NFormItem>
      <NFormItem v-if="errorMsg">
        <span style="color: #e88080; font-size: 13px">{{ errorMsg }}</span>
      </NFormItem>
    </NForm>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="emit('cancel')">取消</NButton>
        <NButton type="primary" :loading="saving" @click="save">
          {{ props.agentId ? '保存' : '创建' }}
        </NButton>
      </NSpace>
    </template>
  </NModal>

  <!-- Nested ModelDialog for inline add -->
  <ModelDialog
    v-if="showModelDialog"
    :model-id="null"
    @saved="(id) => onModelSaved(id)"
    @cancel="showModelDialog = false"
  />
</template>

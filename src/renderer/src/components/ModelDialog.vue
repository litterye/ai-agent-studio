<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NModal, NForm, NFormItem, NInput, NSelect, NButton, NSpace } from 'naive-ui'

const props = defineProps<{ modelId: string | null }>()
const emit = defineEmits<{ saved: [id: string]; cancel: [] }>()

const saving = ref(false)
const errorMsg = ref('')

const form = ref({
  name: '',
  protocol: 'anthropic' as 'anthropic' | 'openai',
  baseUrl: '',
  modelId: '',
  apiKey: '',
  visionMode: 'text' as 'auto' | 'native' | 'text'
})

const protocolOptions = [
  { label: 'Anthropic', value: 'anthropic' },
  { label: 'OpenAI（兼容）', value: 'openai' }
]

const visionModeOptions = [
  { label: '自动检测 — 视觉模型传像素，文本模型标注', value: 'auto' },
  { label: '原生传入 — 始终发送 image 块（仅视觉模型）', value: 'native' },
  { label: '文本标注 — 始终发送文件元数据（安全，通用）', value: 'text' }
]

onMounted(async () => {
  if (props.modelId) {
    const models = await window.api.models.list()
    const m = models.find(x => x.id === props.modelId)
    if (m) {
      form.value = {
        name: m.name,
        protocol: m.protocol,
        baseUrl: m.baseUrl,
        modelId: m.modelId,
        apiKey: '', // never sent to renderer — user enters new key if desired
        visionMode: m.visionMode || 'text'
      }
    }
  }
})

async function save(): Promise<void> {
  if (!form.value.name.trim()) {
    errorMsg.value = '请输入模型名称'
    return
  }
  if (!form.value.modelId.trim()) {
    errorMsg.value = '请输入模型 ID'
    return
  }
  // Trim whitespace from apiKey to avoid accidental leading/trailing spaces
  const trimmedApiKey = form.value.apiKey.trim()
  const trimmedBaseUrl = form.value.baseUrl.trim()
  saving.value = true
  errorMsg.value = ''
  try {
    if (props.modelId) {
      await window.api.models.update(props.modelId, {
        name: form.value.name,
        protocol: form.value.protocol,
        baseUrl: trimmedBaseUrl,
        modelId: form.value.modelId,
        apiKey: trimmedApiKey,
        visionMode: form.value.visionMode
      })
      emit('saved', props.modelId)
    } else {
      const created = await window.api.models.create({
        name: form.value.name,
        protocol: form.value.protocol,
        baseUrl: trimmedBaseUrl,
        modelId: form.value.modelId,
        apiKey: trimmedApiKey,
        visionMode: form.value.visionMode
      })
      emit('saved', created.id)
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
    :title="props.modelId ? '编辑模型' : '添加模型'"
    style="width: 520px; max-width: 94vw"
    :mask-closable="false"
    @update:show="(v) => { if (!v) emit('cancel') }"
  >
    <NForm :model="form">
      <NFormItem label="名称" required>
        <NInput v-model:value="form.name" placeholder="例如：Claude Opus 4.8" />
      </NFormItem>
      <NFormItem label="协议" required>
        <NSelect v-model:value="form.protocol" :options="protocolOptions" />
      </NFormItem>
      <NFormItem label="模型 ID" required>
        <NInput v-model:value="form.modelId" placeholder="例如：claude-opus-4-8 或 gpt-4o" />
      </NFormItem>
      <NFormItem label="视觉模式" hint="控制图片附件如何发送给模型">
        <NSelect
          v-model:value="form.visionMode"
          :options="visionModeOptions"
        />
      </NFormItem>
      <NFormItem label="Base URL">
        <NInput
          v-model:value="form.baseUrl"
          :placeholder="form.protocol === 'anthropic' ? '留空使用默认 https://api.anthropic.com' : '如 https://api.openai.com/v1'"
        />
      </NFormItem>
      <NFormItem :label="props.modelId ? 'API Key（留空保留原有）' : 'API Key'">
        <NInput
          v-model:value="form.apiKey"
          type="password"
          show-password-on="click"
          :placeholder="props.modelId ? '留空不修改' : '可选，按模型独立配置'"
        />
      </NFormItem>
      <NFormItem v-if="errorMsg">
        <span style="color: #e88080; font-size: 13px">{{ errorMsg }}</span>
      </NFormItem>
    </NForm>
    <template #footer>
      <NSpace justify="end">
        <NButton @click="emit('cancel')">取消</NButton>
        <NButton type="primary" :loading="saving" @click="save">
          {{ props.modelId ? '保存' : '添加' }}
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

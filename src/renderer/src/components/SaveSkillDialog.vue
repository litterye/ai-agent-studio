<script setup lang="ts">
import { ref } from 'vue'
import { NModal, NForm, NFormItem, NInput, NButton, NSpace } from 'naive-ui'

const emit = defineEmits<{ save: [payload: { name: string; description: string }]; cancel: [] }>()

const saving = ref(false)
const errorMsg = ref('')

const form = ref({
  name: '',
  description: ''
})

async function save(): Promise<void> {
  if (!form.value.name.trim()) {
    errorMsg.value = '请输入技能名称'
    return
  }
  if (!form.value.description.trim()) {
    errorMsg.value = '请输入技能描述'
    return
  }
  saving.value = true
  errorMsg.value = ''
  emit('save', {
    name: form.value.name.trim(),
    description: form.value.description.trim()
  })
  saving.value = false
}
</script>

<template>
  <NModal
    :show="true"
    preset="card"
    title="保存为技能"
    style="width: 520px; max-width: 94vw"
    :mask-closable="false"
    @update:show="(v) => { if (!v) emit('cancel') }"
  >
    <NForm :model="form">
      <NFormItem label="技能名称" required>
        <NInput v-model:value="form.name" placeholder="例如：代码审查" />
      </NFormItem>
      <NFormItem label="技能描述" required>
        <NInput
          v-model:value="form.description"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 4 }"
          placeholder="描述何时使用此技能，触发条件是什么"
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
          保存
        </NButton>
      </NSpace>
    </template>
  </NModal>
</template>

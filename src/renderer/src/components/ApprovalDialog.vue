<script setup lang="ts">
import { computed } from 'vue'
import { NCard, NTag, NSpace, NButton, NText, NScrollbar } from 'naive-ui'
import type { PolicyReason } from '@shared/ipc'

const props = defineProps<{
  toolName: string
  input: unknown
  reason: PolicyReason | null
}>()

const emit = defineEmits<{
  (e: 'respond', res: { approved: boolean; sessionAlways: boolean }): void
}>()

const inputStr = computed(() => {
  try {
    return JSON.stringify(props.input, null, 2)
  } catch {
    return String(props.input)
  }
})

const ruleLabel: Record<PolicyReason['rule'], string> = {
  'dangerous-command': '危险命令',
  'smart-approve-deny': '辅助模型判定为不安全',
  'write-denylist': '写路径被拒绝',
  'default-confirm': '默认需要确认',
  'toolset-disabled': '工具集未启用',
  yolo: 'YOLO'
}

const ruleType: Record<PolicyReason['rule'], 'error' | 'warning' | 'info' | 'default'> = {
  'dangerous-command': 'error',
  'smart-approve-deny': 'warning',
  'write-denylist': 'error',
  'default-confirm': 'info',
  'toolset-disabled': 'warning',
  yolo: 'default'
}

const detailEntries = computed(() => {
  if (!props.reason?.detail) return []
  return Object.entries(props.reason.detail).map(([k, v]) => ({
    key: k,
    value: typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  }))
})

function approveOnce(): void {
  emit('respond', { approved: true, sessionAlways: false })
}

function approveSession(): void {
  emit('respond', { approved: true, sessionAlways: true })
}

function deny(): void {
  emit('respond', { approved: false, sessionAlways: false })
}
</script>

<template>
  <NCard
    class="approval-dialog"
    :bordered="false"
    role="dialog"
    aria-modal="true"
  >
    <div class="head">
      <NSpace align="center" size="small">
        <span class="title">工具调用确认</span>
        <NTag size="small" round :type="ruleType[reason?.rule ?? 'default-confirm']">
          {{ ruleLabel[reason?.rule ?? 'default-confirm'] }}
        </NTag>
      </NSpace>
    </div>

    <div class="row">
      <NText depth="3" class="label">工具</NText>
      <code class="code">{{ toolName }}</code>
    </div>

    <div v-if="reason" class="row">
      <NText depth="3" class="label">触发规则</NText>
      <div class="reason">{{ reason.message }}</div>
    </div>

    <div v-if="detailEntries.length" class="row">
      <NText depth="3" class="label">详情</NText>
      <div v-for="d in detailEntries" :key="d.key" class="detail-row">
        <span class="detail-key">{{ d.key }}</span>
        <NScrollbar style="max-height: 120px">
          <pre class="code">{{ d.value }}</pre>
        </NScrollbar>
      </div>
    </div>

    <div class="row">
      <NText depth="3" class="label">参数</NText>
      <NScrollbar style="max-height: 220px">
        <pre class="code">{{ inputStr }}</pre>
      </NScrollbar>
    </div>

    <div class="actions">
      <NButton @click="deny">拒绝</NButton>
      <NButton @click="approveOnce">允许本次</NButton>
      <NButton type="primary" @click="approveSession">
        始终允许本会话
      </NButton>
    </div>
  </NCard>
</template>

<style scoped>
.approval-dialog {
  width: 520px;
  max-width: 92vw;
  background: #1f1f1f;
  border: 1px solid rgba(255, 255, 255, 0.08);
}
.head {
  margin-bottom: 12px;
}
.title {
  font-weight: 600;
  font-size: 15px;
}
.row {
  margin: 10px 0;
}
.label {
  display: block;
  font-size: 12px;
  margin-bottom: 4px;
}
.code {
  background: #0d1117;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-word;
  display: block;
  font-family: 'Cascadia Code', Consolas, monospace;
}
.reason {
  background: rgba(255, 77, 79, 0.08);
  border-left: 3px solid #ff7875;
  padding: 6px 10px;
  border-radius: 4px;
  font-size: 13px;
}
.detail-row {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: 4px 0;
}
.detail-key {
  font-size: 11px;
  opacity: 0.6;
  flex-shrink: 0;
  min-width: 80px;
  text-transform: uppercase;
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
</style>
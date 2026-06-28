<script setup lang="ts">
import { computed } from 'vue'
import { NTag, NCollapse, NCollapseItem } from 'naive-ui'
import type { ToolCallView } from '../stores/conversation'

const props = defineProps<{ toolCall: ToolCallView }>()

const tagType = computed(() => {
  switch (props.toolCall.status) {
    case 'success':
      return 'success'
    case 'error':
      return 'error'
    default:
      return 'info'
  }
})

const inputStr = computed(() => JSON.stringify(props.toolCall.input, null, 2))
</script>

<template>
  <div class="tool-card">
    <div class="tool-head">
      <NTag :type="tagType" size="small" round>{{ toolCall.name }}</NTag>
      <span class="status">{{ toolCall.status }}</span>
    </div>
    <NCollapse>
      <NCollapseItem title="参数 / 结果" name="detail">
        <div class="label">输入</div>
        <pre class="code">{{ inputStr }}</pre>
        <template v-if="toolCall.result !== undefined">
          <div class="label">结果</div>
          <pre class="code">{{ toolCall.result }}</pre>
        </template>
      </NCollapseItem>
    </NCollapse>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  padding: 8px 10px;
  margin: 6px 0;
  background: rgba(255, 255, 255, 0.03);
}
.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.status {
  font-size: 12px;
  opacity: 0.6;
}
.label {
  font-size: 12px;
  opacity: 0.6;
  margin: 4px 0 2px;
}
.code {
  background: #0d1117;
  padding: 8px;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12px;
  max-height: 240px;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>

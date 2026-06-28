<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue'
import { NDataTable, NButton, NSpace, NTag } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { ToolInfo } from '@shared/ipc'

const tools = ref<ToolInfo[]>([])
const loading = ref(false)

const builtinTools = computed(() => tools.value.filter((t) => t.source === 'builtin'))

const columns: DataTableColumns<ToolInfo> = [
  { title: '名称', key: 'name', width: 220 },
  {
    title: '工具集',
    key: 'toolset',
    width: 100,
    render: (row) => h(NTag, { size: 'small' }, () => row.toolset)
  },
  {
    title: '需确认',
    key: 'needsConfirmation',
    width: 80,
    render: (row) => (row.needsConfirmation ? '是' : '否')
  },
  { title: '描述', key: 'description' }
]

async function refresh(): Promise<void> {
  loading.value = true
  try {
    tools.value = await window.api.tools.list()
  } finally {
    loading.value = false
  }
}

onMounted(refresh)
</script>

<template>
  <div class="tools">
    <NSpace justify="space-between" align="center" style="margin-bottom: 12px">
      <h2 style="margin: 0">内置工具</h2>
      <NButton :loading="loading" @click="refresh">刷新</NButton>
    </NSpace>
    <p class="hint">
      内置工具会在每轮对话中作为可用工具提供给模型。MCP 工具请在「MCP」页面管理。
    </p>
    <NDataTable :columns="columns" :data="builtinTools" :bordered="false" size="small" />
  </div>
</template>

<style scoped>
.tools {
  padding: 20px;
  height: 100vh;
  overflow-y: auto;
}
.hint {
  opacity: 0.6;
  font-size: 13px;
  margin-bottom: 12px;
}
</style>

<script setup lang="ts">
import { ref, onMounted, computed, watch } from 'vue'
import {
  NInput,
  NButton,
  NSpace,
  NTag,
  NSpin,
  NScrollbar,
  NEmpty,
  NModal,
  NCard,
  useMessage
} from 'naive-ui'
import type { WorkspaceDirEntry, WorkspaceReadResult, WorkspaceConfig } from '@shared/ipc'

const msg = useMessage()

const wsConfig = ref<WorkspaceConfig>({ defaultCwd: '', sessions: {} })
const cwdDraft = ref('')
const entries = ref<WorkspaceDirEntry[]>([])
const loading = ref(false)
const selectedPath = ref<string | null>(null)
const selectedEntry = ref<WorkspaceDirEntry | null>(null)
const preview = ref<WorkspaceReadResult | null>(null)
const previewing = ref(false)

const currentPath = computed(() => cwdDraft.value || wsConfig.value.defaultCwd)

async function loadConfig(): Promise<void> {
  wsConfig.value = await window.api.workspace.get()
  cwdDraft.value = wsConfig.value.defaultCwd
  if (cwdDraft.value) await loadDir()
}

async function loadDir(): Promise<void> {
  if (!currentPath.value) return
  loading.value = true
  try {
    entries.value = await window.api.workspace.list({ path: currentPath.value })
  } catch (err) {
    entries.value = []
    msg.error(String(err))
  } finally {
    loading.value = false
  }
}

async function setCwd(): Promise<void> {
  if (!cwdDraft.value) return
  try {
    await window.api.workspace.setCwd({ cwd: cwdDraft.value })
    msg.success('工作目录已更新')
    await loadDir()
  } catch (err) {
    msg.error(String(err))
  }
}

function onCwdBlur(): void {
  if (cwdDraft.value !== wsConfig.value.defaultCwd) setCwd()
}

async function goUp(): Promise<void> {
  const segs = currentPath.value.replace(/\\/g, '/').split('/').filter(Boolean)
  segs.pop()
  const up = segs.length ? (currentPath.value.startsWith('/') ? '/' : '') + segs.join('/') : currentPath.value
  cwdDraft.value = up
  await setCwd()
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|svg|webp|ico)$/i.test(name)
}

async function onEntryClick(entry: WorkspaceDirEntry): Promise<void> {
  selectedEntry.value = entry
  if (entry.kind === 'dir') {
    // Navigate into it
    const sep = currentPath.value.includes('\\') ? '\\' : '/'
    const sub = currentPath.value.replace(/[\\/]+$/, '') + sep + entry.name
    cwdDraft.value = sub
    await setCwd()
    return
  }
  // File preview
  if (isImage(entry.name)) {
    preview.value = null
    selectedPath.value = entry.name
    return
  }
  previewing.value = true
  try {
    const filePath = currentPath.value.replace(/[\\/]+$/, '') + '\\' + entry.name
    preview.value = await window.api.workspace.read({ path: filePath })
    selectedPath.value = entry.name
  } catch (err) {
    msg.error(String(err))
  } finally {
    previewing.value = false
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString()
}

onMounted(loadConfig)
</script>

<template>
  <div class="workspace">
    <!-- Top bar: cwd path input -->
    <div class="top-bar">
      <NSpace align="center" :wrap="false">
        <span class="label">工作目录</span>
        <NInput
          v-model:value="cwdDraft"
          placeholder="输入或粘贴路径，回车确认"
          style="flex: 1; min-width: 300px"
          @keyup.enter="setCwd"
          @blur="onCwdBlur"
        />
        <NButton size="small" @click="goUp">↩ 上级</NButton>
        <NButton size="small" @click="setCwd" :disabled="cwdDraft === wsConfig.defaultCwd">
          确认
        </NButton>
      </NSpace>
    </div>

    <!-- Body: file tree + preview -->
    <div class="body">
      <!-- Left: directory listing -->
      <div class="tree-pane">
        <NSpin :show="loading" style="height: 100%">
          <NScrollbar>
            <div
              v-for="e in entries"
              :key="e.name"
              class="entry-row"
              :class="{ selected: selectedEntry?.name === e.name }"
              @click="() => onEntryClick(e)"
            >
              <span class="icon">{{ e.kind === 'dir' ? '📁' : '📄' }}</span>
              <span class="ename">{{ e.name }}</span>
              <span v-if="e.size > 0" class="esize">{{ (e.size / 1024).toFixed(1) }}K</span>
            </div>
          </NScrollbar>
          <div v-if="!loading && entries.length === 0" style="padding: 20px; opacity: 0.5; text-align:center">
            目录为空或无法访问
          </div>
        </NSpin>
      </div>

      <!-- Right: file preview -->
      <div class="preview-pane">
        <template v-if="!selectedPath">
          <NEmpty description="选择文件预览" />
        </template>
        <template v-else-if="previewing">
          <NSpin />
        </template>
        <template v-else-if="preview">
          <div class="preview-head">
            <NTag size="small">{{ selectedPath }}</NTag>
            <span class="meta">
              {{ preview.totalLines }} 行 · {{ (preview.fileSize / 1024).toFixed(1) }} KB
              <template v-if="preview.isBinary"> · 二进制</template>
              <template v-if="preview.truncated"> · 已截断</template>
            </span>
          </div>
          <NScrollbar style="flex:1">
            <pre class="content"><code>{{ preview.error || preview.content }}</code></pre>
          </NScrollbar>
        </template>
        <template v-else>
          <div class="image-preview">
            <span>图片预览：{{ selectedPath }}</span>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace {
  display: flex;
  flex-direction: column;
  height: 100vh;
}
.top-bar {
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.label {
  font-size: 13px;
  opacity: 0.7;
  white-space: nowrap;
}
.body {
  display: flex;
  flex: 1;
  overflow: hidden;
}
.tree-pane {
  width: 300px;
  min-width: 200px;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  overflow-y: auto;
}
.entry-row {
  display: flex;
  align-items: center;
  padding: 5px 12px;
  gap: 6px;
  cursor: pointer;
  font-size: 13px;
}
.entry-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.entry-row.selected {
  background: rgba(42, 108, 240, 0.15);
}
.icon {
  font-size: 14px;
}
.ename {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.esize {
  font-size: 11px;
  opacity: 0.5;
  flex-shrink: 0;
}
.preview-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.preview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
.meta {
  font-size: 11px;
  opacity: 0.6;
}
.content {
  padding: 12px;
  margin: 0;
  font-size: 12px;
  font-family: 'Cascadia Code', Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}
.image-preview {
  padding: 40px;
  opacity: 0.5;
  text-align: center;
}
</style>
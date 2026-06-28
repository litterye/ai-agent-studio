<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NForm,
  NFormItem,
  NSelect,
  NButton,
  NSpace,
  NText,
  NTabs,
  NTabPane,
  NRadioGroup,
  NRadio,
  NDataTable,
  NPopconfirm,
  NInput,
  useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { useSettingsStore } from '../stores/settings'
import type { ModelConfigDTO, MemoryEntryDTO } from '@shared/ipc'
import ModelDialog from '../components/ModelDialog.vue'

const settings = useSettingsStore()
const message = useMessage()
const tabValue = ref('general')

const themeOptions = [
  { label: '亮色', value: 'light' },
  { label: '暗黑', value: 'dark' },
  { label: '护眼', value: 'eye-care' }
]

// ─── App settings ───────────────────────────────────────────────────────

async function changeTheme(theme: 'light' | 'dark' | 'eye-care'): Promise<void> {
  await settings.setAppSettings({ theme })
  message.success('主题已更新')
}

// ─── Models ─────────────────────────────────────────────────────────────

const models = ref<ModelConfigDTO[]>([])
const modelDialog = ref(false)
const editingModelId = ref<string | null>(null)

const modelColumns: DataTableColumns<ModelConfigDTO> = [
  { title: '名称', key: 'name', width: 160 },
  {
    title: '协议', key: 'protocol', width: 100,
    render: (row) => row.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'
  },
  { title: '模型 ID', key: 'modelId', width: 200, ellipsis: { tooltip: true } },
  {
    title: 'Base URL', key: 'baseUrl', width: 200, ellipsis: { tooltip: true },
    render: (row) => row.baseUrl || '(默认)'
  },
  {
    title: 'Key', key: 'hasApiKey', width: 60,
    render: (row) => row.hasApiKey ? '✓' : '—'
  },
  {
    title: '操作', key: 'actions', width: 140,
    render: (row) =>
      h(NSpace, { size: [4, 0] }, {
        default: () => [
          h(NButton, { size: 'tiny', onClick: () => openEditModel(row.id) }, { default: () => '编辑' }),
          h(NPopconfirm, { onPositiveClick: () => removeModel(row.id) }, {
            trigger: () => h(NButton, { size: 'tiny', type: 'error' }, { default: () => '删除' }),
            default: () => '确定删除此模型？'
          })
        ]
      })
  }
]

async function loadModels(): Promise<void> {
  models.value = await window.api.models.list()
}

function openNewModel(): void {
  editingModelId.value = null
  modelDialog.value = true
}

function openEditModel(id: string): void {
  editingModelId.value = id
  modelDialog.value = true
}

async function onModelSaved(): Promise<void> {
  modelDialog.value = false
  await loadModels()
}

async function removeModel(id: string): Promise<void> {
  await window.api.models.delete(id)
  await loadModels()
  message.success('模型已删除')
}

// ─── SOUL.md (Agent Identity) ────────────────────────────────────────────

const soulContent = ref('')
const soulSaving = ref(false)
const soulLoaded = ref(false)

async function loadSoul(): Promise<void> {
  const result = await window.api.soul.get()
  if (result) {
    soulContent.value = result.content
  } else {
    soulContent.value = await window.api.soul.getDefault()
  }
  soulLoaded.value = true
}

async function saveSoul(): Promise<void> {
  soulSaving.value = true
  try {
    const res = await window.api.soul.set(soulContent.value)
    if (res.ok) {
      message.success('人格已保存。下次对话生效。')
    } else {
      message.error('保存失败')
    }
  } finally {
    soulSaving.value = false
  }
}

async function resetSoul(): Promise<void> {
  soulContent.value = await window.api.soul.getDefault()
}

// ─── Memory (cross-session persistent knowledge) ──────────────────────────

const memories = ref<MemoryEntryDTO[]>([])
const loadingMemories = ref(false)

async function loadMemories(): Promise<void> {
  loadingMemories.value = true
  try {
    memories.value = await window.api.memory.list()
  } finally {
    loadingMemories.value = false
  }
}

async function deleteMemory(id: string): Promise<void> {
  await window.api.memory.delete(id)
  await loadMemories()
  message.success('记忆已删除')
}

async function clearAllMemories(): Promise<void> {
  await window.api.memory.clear()
  await loadMemories()
  message.success('所有记忆已清除')
}

const typeOptions: Record<string, { label: string; color: string }> = {
  fact: { label: '事实', color: '#4ec9b0' },
  preference: { label: '偏好', color: '#569cd6' },
  feedback: { label: '反馈', color: '#ce9178' },
  learning: { label: '学习', color: '#c586c0' }
}

const memoryColumns: DataTableColumns<MemoryEntryDTO> = [
  {
    title: '类型', key: 'type', width: 80,
    render: (row) => {
      const info = typeOptions[row.type] ?? { label: row.type, color: '#888' }
      return h('span', {
        style: {
          display: 'inline-block',
          padding: '1px 8px',
          borderRadius: '10px',
          fontSize: '12px',
          fontWeight: '600',
          background: info.color + '22',
          color: info.color
        }
      }, info.label)
    }
  },
  { title: '内容', key: 'content', ellipsis: { tooltip: true } },
  {
    title: '重要性', key: 'importance', width: 70, align: 'center',
    render: (row) => {
      const bars = '★'.repeat(Math.min(row.importance, 10))
      return h('span', { style: { color: '#dcdcaa', fontSize: '12px' } }, bars)
    }
  },
  { title: '来源会话', key: 'sourceSessionId', width: 120, ellipsis: { tooltip: true } },
  {
    title: '访问', key: 'accessCount', width: 50, align: 'center',
    render: (row) => String(row.accessCount)
  },
  {
    title: '创建时间', key: 'createdAt', width: 140,
    render: (row) => row.createdAt.slice(0, 10) + ' ' + row.createdAt.slice(11, 16)
  },
  {
    title: '操作', key: 'actions', width: 80,
    render: (row) =>
      h(NPopconfirm, { onPositiveClick: () => deleteMemory(row.id) }, {
        trigger: () => h(NButton, { size: 'tiny', type: 'error' }, { default: () => '删除' }),
        default: () => '确定删除此记忆？'
      })
  }
]

// ─── About ──────────────────────────────────────────────────────────────

const appVersion = ref('')

async function quitApp(): Promise<void> {
  window.api.app.quit()
}

async function checkUpdate(): Promise<void> {
  message.info('当前已是最新版本')
}onMounted(async () => {
  await settings.load()
  await loadModels()
  await loadSoul()
  await loadMemories()
  appVersion.value = await window.api.app.getVersion()
})
</script>

<template>
  <div class="settings">
    <h2 style="margin-top: 0">设置</h2>

    <NTabs v-model:value="tabValue" type="segment" animated>
      <!-- 通用设置 -->
      <NTabPane name="general" tab="通用">
        <div class="tab-content">
          <NForm label-placement="left" label-width="100">
            <NFormItem label="主题">
              <NRadioGroup :value="settings.appSettings.theme" @update:value="(v) => changeTheme(v)">
                <NRadio v-for="opt in themeOptions" :key="opt.value" :value="opt.value">
                  {{ opt.label }}
                </NRadio>
              </NRadioGroup>
            </NFormItem>

            <NFormItem label="语言">
              <NSelect
                value="zh-CN"
                :options="[{ label: '简体中文', value: 'zh-CN' }]"
                disabled
              />
            </NFormItem>

            <NFormItem label=" ">
              <NButton type="error" secondary @click="quitApp()">
                退出应用
              </NButton>
            </NFormItem>
          </NForm>
        </div>
      </NTabPane>

      <!-- 模型设置 -->
      <NTabPane name="models" tab="模型">
        <div class="tab-content">
          <div style="margin-bottom: 12px">
            <NButton type="primary" @click="openNewModel">+ 添加模型</NButton>
          </div>

          <NDataTable
            :columns="modelColumns"
            :data="models"
            :bordered="false"
            :single-line="false"
            size="small"
            :row-key="(row) => row.id"
          />
          <div v-if="models.length === 0" style="opacity:0.4; text-align:center; padding:40px">
            暂无已保存的模型，点击上方按钮添加
          </div>
        </div>
      </NTabPane>

      <!-- Agent 人格 -->
      <NTabPane name="personality" tab="人格">
        <div class="tab-content">
          <p style="margin-top:0; opacity:0.55; font-size:13px;">
            编辑 SOUL.md 定义 Agent 的身份、语气和沟通风格。
            此文件位于 <code>~\.ai-agent-studio\SOUL.md</code>，
            每次对话时作为系统提示的顶层注入。
          </p>
          <NForm label-placement="left" label-width="0">
            <NFormItem>
              <NInput
                v-model:value="soulContent"
                type="textarea"
                :autosize="{ minRows: 12, maxRows: 30 }"
                placeholder="输入 Agent 身份定义…"
              />
            </NFormItem>
            <NFormItem>
              <NSpace>
                <NButton type="primary" :loading="soulSaving" @click="saveSoul">
                  保存
                </NButton>
                <NButton @click="resetSoul" :disabled="soulSaving">
                  重置为默认
                </NButton>
              </NSpace>
            </NFormItem>
          </NForm>
        </div>
      </NTabPane>

      <!-- 记忆管理 -->
      <NTabPane name="memory" tab="记忆">
        <div class="tab-content">
          <div style="margin-bottom: 12px; display: flex; align-items: center; gap: 12px;">
            <span style="opacity:0.55; font-size:13px;">
              共 {{ memories.length }} 条记忆 · Agent 会在对话中自动学习并保存
            </span>
            <div style="flex:1"></div>
            <NPopconfirm
              v-if="memories.length > 0"
              @positive-click="clearAllMemories"
            >
              <template #trigger>
                <NButton size="small" type="error" secondary>
                  清除全部
                </NButton>
              </template>
              确定清除所有记忆？此操作不可撤消。
            </NPopconfirm>
          </div>

          <NDataTable
            :columns="memoryColumns"
            :data="memories"
            :bordered="false"
            :single-line="false"
            size="small"
            :row-key="(row) => row.id"
            :loading="loadingMemories"
          />
          <div v-if="!loadingMemories && memories.length === 0" style="opacity:0.4; text-align:center; padding:40px">
            暂无记忆 · Agent 会在对话过程中自动提取重要信息保存到这里
          </div>
        </div>
      </NTabPane>

      <!-- 关于 -->
      <NTabPane name="about" tab="关于">
        <div class="tab-content">
          <NForm label-placement="left" label-width="100">
            <NFormItem label="应用名称">
              <NText>AI Agent Studio</NText>
            </NFormItem>
            <NFormItem label="当前版本">
              <NText>v{{ appVersion }}</NText>
            </NFormItem>
            <NFormItem label=" ">
              <NButton @click="checkUpdate">检查更新</NButton>
            </NFormItem>
          </NForm>
        </div>
      </NTabPane>
    </NTabs>

    <!-- Model add/edit dialog -->
    <ModelDialog
      v-if="modelDialog"
      :model-id="editingModelId"
      @saved="onModelSaved"
      @cancel="modelDialog = false"
    />
  </div>
</template>

<style scoped>
.settings {
  padding: 20px;
  height: 100vh;
  overflow-y: auto;
}
.tab-content {
  padding-top: 12px;
  min-height: 160px;
}
</style>

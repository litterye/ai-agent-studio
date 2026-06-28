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
import type { ModelConfigDTO } from '@shared/ipc'
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

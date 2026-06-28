<script setup lang="ts">
import { ref, onMounted, h, computed } from 'vue'
import {
  NDataTable, NButton, NTag, NSpace, NModal, NScrollbar,
  NEmpty, NSpin, NTabs, NTabPane, NCard, useMessage
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'

const msg = useMessage()
const loading = ref(false)
const skills = ref<Array<{ relativePath: string; name: string; description: string; category: string; frontmatter: unknown }>>([])
const pending = ref<Array<{ id: string; draft: { name: string; description: string; category: string; fullMarkdown: string }; createdAt: string }>>([])
const viewingPath = ref<string | null>(null)
const viewingBody = ref<string | null>(null)
const previewing = ref(false)

const categories = computed(() => {
  const cats = new Map<string, typeof skills.value>()
  for (const s of skills.value) {
    const c = s.category
    if (!cats.has(c)) cats.set(c, [])
    cats.get(c)!.push(s)
  }
  return [...cats.entries()]
})

async function loadSkills(): Promise<void> {
  loading.value = true
  try {
    skills.value = await window.api.skills.list()
    const raw: any[] = await window.api.skills.pendingList()
    pending.value = raw.map(p => ({
      id: String(p?.id ?? ''),
      draft: {
        name: String(p?.draft?.name ?? ''),
        description: String(p?.draft?.description ?? ''),
        category: String(p?.draft?.category ?? 'general'),
        fullMarkdown: String(p?.draft?.fullMarkdown ?? '')
      },
      createdAt: String(p?.createdAt ?? '')
    }))
  } finally {
    loading.value = false
  }
}

async function viewSkill(path: string): Promise<void> {
  previewing.value = true
  viewingPath.value = path
  try {
    const result = await window.api.skills.get(path)
    viewingBody.value = result?.body ?? '(no content)'
  } catch {
    viewingBody.value = '(error loading)'
  } finally {
    previewing.value = false
  }
}

async function approvePending(id: string): Promise<void> {
  const result = await window.api.skills.pendingReview({ id, approve: true })
  if (result.ok) {
    msg.success('技能已发布')
    await loadSkills()
  } else {
    msg.error(result.error ?? '操作失败')
  }
}

async function rejectPending(id: string): Promise<void> {
  await window.api.skills.pendingReview({ id, approve: false })
  await loadSkills()
}

const skillColumns: DataTableColumns<any> = [
  { title: '名称', key: 'name', width: 200 },
  { title: '分类', key: 'category', width: 120, render: (row) => h(NTag, { size: 'small' }, () => row.category) },
  { title: '路径', key: 'relativePath', width: 200 },
  { title: '描述', key: 'description' },
  { title: '操作', key: 'actions', width: 100, render: (row) =>
    h(NButton, { size: 'tiny', onClick: () => viewSkill(row.relativePath) }, () => '查看')
  }
]

const pendingColumns: DataTableColumns<typeof pending.value[0]> = [
  { title: '名称', key: 'draft.name', width: 180, render: (row) => row.draft?.name ?? '—' },
  { title: '描述', key: 'draft.description', width: 260, render: (row) => row.draft?.description ?? '—' },
  { title: '分类', key: 'draft.category', width: 100, render: (row) =>
    h(NTag, { size: 'small' }, () => row.draft?.category ?? 'general')
  },
  { title: '创建时间', key: 'createdAt', width: 180, render: (row) => {
    const t = row?.createdAt
    if (!t) return '—'
    const d = new Date(t)
    if (isNaN(d.getTime())) return String(t)
    return d.toLocaleString()
  }},
  { title: '操作', key: 'actions', width: 160, render: (row) =>
    h(NSpace, { size: 'small' }, () => [
      h(NButton, { size: 'tiny', type: 'primary', onClick: () => approvePending(row.id) }, () => '发布'),
      h(NButton, { size: 'tiny', onClick: () => rejectPending(row.id) }, () => '丢弃')
    ])
  }
]

onMounted(loadSkills)
</script>

<template>
  <div class="skills">
    <NSpace justify="space-between" align="center" style="margin-bottom: 12px">
      <h2 style="margin: 0">技能管理</h2>
      <NButton :loading="loading" @click="loadSkills">刷新</NButton>
    </NSpace>

    <NTabs type="line" animated>
      <NTabPane name="installed" tab="已安装">
        <NSpin :show="loading">
          <div v-if="categories.length === 0 && !loading" style="padding: 20px; text-align:center; opacity: 0.5">
            暂无技能。在 ~/.ai-agent-studio/skills/ 下创建 SKILL.md 或在对话中点击「保存为技能」。
          </div>
          <div v-for="[cat, catSkills] in categories" :key="cat" style="margin-bottom: 16px">
            <NText depth="3" style="font-size: 12px; text-transform: uppercase; letter-spacing: 1px">
              {{ cat }}
            </NText>
            <NSpin :show="loading">
              <NDataTable
                :columns="skillColumns"
                :data="catSkills"
                :bordered="false"
                size="small"
              />
            </NSpin>
          </div>
        </NSpin>
      </NTabPane>
      <NTabPane name="pending" tab="待审核">
        <NSpin :show="loading">
          <NEmpty v-if="pending.length === 0 && !loading" description="暂无待审核的技能。" />
          <NDataTable
            v-else
            :columns="pendingColumns"
            :data="pending"
            :bordered="false"
            size="small"
          />
        </NSpin>
      </NTabPane>
    </NTabs>

    <!-- Preview modal -->
    <NModal
      :show="viewingPath !== null"
      preset="card"
      :title="viewingPath ?? '技能预览'"
      style="width: 680px; max-width: 94vw"
      @update:show="(v) => { if (!v) { viewingPath = null; viewingBody = null } }"
    >
      <NSpin :show="previewing" style="min-height: 120px">
        <NScrollbar style="max-height: 70vh">
          <pre class="md-preview"><code>{{ viewingBody }}</code></pre>
        </NScrollbar>
      </NSpin>
    </NModal>
  </div>
</template>

<style scoped>
.skills { padding: 20px; height: 100vh; overflow-y: auto; }
.md-preview {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: #0d1117;
  padding: 16px;
  border-radius: 8px;
  margin: 0;
}
</style>
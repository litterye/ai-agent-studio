<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NDataTable, NButton, NTag, NSpace, NModal, NForm, NFormItem,
  NInput, NSwitch, NText, NEmpty, useMessage, NPopconfirm
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { CronJobDTO, CronStatusDTO } from '@shared/ipc'

const msg = useMessage()
const loading = ref(false)
const status = ref<CronStatusDTO | null>(null)
const showForm = ref(false)
const editId = ref<string | null>(null)

const form = ref({
  id: '',
  name: '',
  scheduleInput: '',
  prompt: '',
  enabledToolsets: '',
  workdir: '',
  paused: false
})

function resetForm(): void {
  form.value = { id: '', name: '', scheduleInput: '', prompt: '', enabledToolsets: '', workdir: '', paused: false }
  editId.value = null
}

function openCreate(): void {
  resetForm()
  showForm.value = true
}

function openEdit(job: CronJobDTO): void {
  form.value = {
    id: job.id,
    name: job.name,
    scheduleInput: job.schedule.kind === 'cron' ? (job.schedule.expr ?? '') : job.schedule.kind === 'interval' ? `every ${job.schedule.minutes}m` : (job.schedule.runAt ?? ''),
    prompt: job.prompt,
    enabledToolsets: (job.enabledToolsets ?? []).join(', '),
    workdir: job.workdir ?? '',
    paused: job.paused
  }
  editId.value = job.id
  showForm.value = true
}

function closeForm(): void {
  showForm.value = false
  resetForm()
}

async function saveForm(): Promise<void> {
  const enabled = form.value.enabledToolsets
    ? form.value.enabledToolsets.split(',').map((s) => s.trim()).filter(Boolean)
    : undefined

  try {
    const result = editId.value
      ? await window.api.cron.update({
          id: editId.value,
          patch: {
            name: form.value.name,
            prompt: form.value.prompt,
            scheduleInput: form.value.scheduleInput,
            enabledToolsets: enabled,
            workdir: form.value.workdir || undefined,
            paused: form.value.paused
          }
        })
      : await window.api.cron.create({
          id: form.value.id,
          name: form.value.name,
          prompt: form.value.prompt,
          scheduleInput: form.value.scheduleInput,
          enabledToolsets: enabled,
          workdir: form.value.workdir || undefined
        })
    if (typeof result === 'string') {
      msg.error(result)
      return
    }
    msg.success(editId.value ? '任务已更新' : '任务已创建')
    closeForm()
    await refresh()
  } catch (err) {
    msg.error(String(err))
  }
}

async function deleteJob(id: string): Promise<void> {
  await window.api.cron.delete(id)
  msg.success('任务已删除')
  await refresh()
}

async function runNow(id: string): Promise<void> {
  loading.value = true
  try {
    const result = await window.api.cron.runNow(id)
    if (result.error) msg.warning(`运行出错: ${result.error}`)
    else msg.success('任务执行完成')
    await refresh()
  } catch (err) {
    msg.error(String(err))
  } finally {
    loading.value = false
  }
}

async function togglePause(job: CronJobDTO): Promise<void> {
  const result = await window.api.cron.update({ id: job.id, patch: { paused: !job.paused } })
  if (typeof result === 'string') msg.error(result)
  else await refresh()
}

async function refresh(): Promise<void> {
  loading.value = true
  try {
    status.value = await window.api.cron.status()
  } finally {
    loading.value = false
  }
}

const scheduleDisplay = (job: CronJobDTO): string => {
  const s = job.schedule
  if (s.kind === 'cron') return `cron: ${s.expr}`
  if (s.kind === 'interval') {
    const m = s.minutes ?? 0
    return m < 60 ? `每 ${m} 分钟` : m < 1440 ? `每 ${Math.floor(m / 60)} 小时` : `每 ${Math.floor(m / 1440)} 天`
  }
  return '单次'
}

const nextRunDisplay = (iso: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (d.getFullYear() > 9000) return '不会再次运行'
  return d.toLocaleString()
}

const columns: DataTableColumns<CronJobDTO> = [
  { title: '名称', key: 'name', width: 140 },
  {
    title: '调度', key: 'schedule', width: 150,
    render: (row) => scheduleDisplay(row)
  },
  {
    title: '下次运行', key: 'nextRunAt', width: 160,
    render: (row) => nextRunDisplay(row.nextRunAt)
  },
  {
    title: '上次运行', key: 'lastRunAt', width: 160,
    render: (row) => row.lastRunAt ? new Date(row.lastRunAt).toLocaleString() : '—'
  },
  {
    title: '状态', key: 'paused', width: 80,
    render: (row) =>
      h(NTag, { type: row.paused ? 'warning' : 'success', size: 'small' }, () =>
        row.paused ? '已暂停' : '运行中'
      )
  },
  {
    title: '操作', key: 'actions', width: 200,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(NButton, { size: 'tiny', onClick: () => openEdit(row) }, () => '编辑'),
        h(NButton, { size: 'tiny', onClick: () => runNow(row.id) }, () => '立即运行'),
        h(NButton, { size: 'tiny', onClick: () => togglePause(row) }, () =>
          row.paused ? '恢复' : '暂停'
        ),
        h(
          NPopconfirm,
          { onPositiveClick: () => deleteJob(row.id) },
          {
            trigger: () => h(NButton, { size: 'tiny', type: 'error' }, () => '删除'),
            default: () => '确认删除此任务？'
          }
        )
      ])
  }
]

onMounted(refresh)
</script>

<template>
  <div class="cron">
    <NSpace justify="space-between" align="center" style="margin-bottom: 12px">
      <h2 style="margin: 0">定时任务</h2>
      <NSpace>
        <NButton :loading="loading" @click="refresh">刷新</NButton>
        <NButton type="primary" @click="openCreate">新建任务</NButton>
      </NSpace>
    </NSpace>

    <!-- Ticker banner -->
    <div v-if="status" class="ticker-banner">
      <NSpace size="small">
        <NTag :type="status.running ? 'success' : 'warning'" size="small">
          调度器: {{ status.running ? '运行中' : '已停止' }}
        </NTag>
        <NText v-if="status.tickerHeartbeat" depth="3" style="font-size: 12px">
          心跳: {{ new Date(status.tickerHeartbeat).toLocaleTimeString() }}
        </NText>
        <NText v-if="status.tickerLastSuccess" depth="3" style="font-size: 12px">
          上次成功: {{ new Date(status.tickerLastSuccess).toLocaleTimeString() }}
        </NText>
      </NSpace>
    </div>

    <NDataTable
      :columns="columns"
      :data="status?.jobs ?? []"
      :bordered="false"
      size="small"
      :loading="loading"
    >
      <template #empty>
        <NEmpty description="暂无定时任务。点击「新建任务」创建第一个。" />
      </template>
    </NDataTable>

    <!-- Create/Edit modal -->
    <NModal
      :show="showForm"
      preset="card"
      :title="editId ? '编辑任务' : '新建任务'"
      style="width: 560px; max-width: 92vw"
      @update:show="(s) => { if (!s) closeForm() }"
    >
      <NForm label-placement="left" label-width="100">
        <NFormItem v-if="!editId" label="ID" required>
          <NInput v-model:value="form.id" placeholder="字母、数字、下划线、连字符" />
        </NFormItem>
        <NFormItem label="名称" required>
          <NInput v-model:value="form.name" placeholder="任务显示名称" />
        </NFormItem>
        <NFormItem label="调度" required>
          <NInput
            v-model:value="form.scheduleInput"
            placeholder="cron: 0 9 * * * | interval: every 30m | once: 2026-06-01T09:00"
          />
          <NText depth="3" style="font-size: 11px; margin-top: 4px">
            支持 cron 表达式（5 字段）、every 30m / every 1h、或 ISO 时间戳（单次）
          </NText>
        </NFormItem>
        <NFormItem label="提示词" required>
          <NInput
            v-model:value="form.prompt"
            type="textarea"
            :autosize="{ minRows: 2, maxRows: 8 }"
            placeholder="作为 user 消息发送给模型的提示词"
          />
        </NFormItem>
        <NFormItem label="工具集">
          <NInput v-model:value="form.enabledToolsets" placeholder="逗号分隔，如 file, terminal。留空使用默认" />
        </NFormItem>
        <NFormItem label="工作目录">
          <NInput v-model:value="form.workdir" placeholder="绝对路径。留空使用用户 home 目录" />
        </NFormItem>
        <NFormItem v-if="editId" label="暂停">
          <NSwitch v-model:value="form.paused" />
        </NFormItem>
      </NForm>
      <template #footer>
        <NSpace>
          <NButton @click="closeForm">取消</NButton>
          <NButton type="primary" @click="saveForm">
            {{ editId ? '保存' : '创建' }}
          </NButton>
        </NSpace>
      </template>
    </NModal>
  </div>
</template>

<style scoped>
.cron {
  padding: 20px;
  height: 100vh;
  overflow-y: auto;
}
.ticker-banner {
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  padding: 8px 12px;
  margin-bottom: 12px;
}
</style>
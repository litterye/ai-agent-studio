<script setup lang="ts">
import { ref, onMounted, h } from 'vue'
import {
  NDataTable, NButton, NTag, NSpace, NModal, NForm, NFormItem,
  NInput, NInputNumber, NSwitch, NText, NEmpty, NSelect,
  NCheckbox, NDatePicker, NTimePicker,
  useMessage, NPopconfirm
} from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import type { CronJobDTO, CronStatusDTO } from '@shared/ipc'

const msg = useMessage()
const loading = ref(false)
const status = ref<CronStatusDTO | null>(null)
const showForm = ref(false)
const editId = ref<string | null>(null)

// ─── Schedule UI types ──────────────────────────────────────────────────

type ScheduleType = 'daily' | 'hourly' | 'once'

const WEEKDAYS = [
  { label: '周一', value: 1 },
  { label: '周二', value: 2 },
  { label: '周三', value: 3 },
  { label: '周四', value: 4 },
  { label: '周五', value: 5 },
  { label: '周六', value: 6 },
  { label: '周日', value: 0 }
]

const scheduleTypeOptions = [
  { label: '每天', value: 'daily' },
  { label: '每小时', value: 'hourly' },
  { label: '某时', value: 'once' }
]

const form = ref({
  name: '',
  prompt: '',
  enabledToolsets: '',
  workdir: '',
  paused: false,
  agentId: '' as string,
  sessionId: '' as string,
  scheduleType: 'daily' as ScheduleType,
  dailyTime: 9 * 3_600_000,
  dailyDays: [1, 2, 3, 4, 5] as number[],
  hourlyInterval: 1,
  hourlyDays: [1, 2, 3, 4, 5] as number[],
  onceDate: Date.now() + 86_400_000,
  onceTime: 9 * 3_600_000
})

const agents = ref<Array<{ id: string; name: string }>>([])
const sessions = ref<Array<{ id: string; title: string }>>([])

// ─── Run history ──────────────────────────────────────────────────────

interface RunHistoryEntry {
  timestamp: string
  content: string
  success: boolean
  fileName: string
}

const historyJobId = ref<string | null>(null)
const historyLoading = ref(false)
const historyEntries = ref<RunHistoryEntry[]>([])
const viewingHistoryContent = ref<string | null>(null)

async function openHistory(jobId: string): Promise<void> {
  historyJobId.value = jobId
  historyLoading.value = true
  historyEntries.value = []
  try {
    const raw: Array<{ timestamp: string; content: string; success: boolean; fileName: string }> =
      await window.api.cron.runHistory(jobId)
    historyEntries.value = raw
  } catch {
    msg.error('加载运行历史失败')
  } finally {
    historyLoading.value = false
  }
}

// ─── Agent/session loading ─────────────────────────────────────────────

async function loadAgents(): Promise<void> {
  agents.value = await window.api.agents.list()
  if (agents.value.length > 0 && !form.value.agentId) {
    form.value.agentId = agents.value[0].id
    await loadSessions()
  }
}

async function loadSessions(): Promise<void> {
  if (!form.value.agentId) { sessions.value = []; return }
  sessions.value = await window.api.sessions.list(form.value.agentId)
}

function resetForm(): void {
  form.value = {
    name: '', prompt: '', enabledToolsets: '', workdir: '', paused: false,
    agentId: agents.value.length > 0 ? agents.value[0].id : '',
    sessionId: '',
    scheduleType: 'daily',
    dailyTime: 9 * 3_600_000, dailyDays: [1, 2, 3, 4, 5],
    hourlyInterval: 1, hourlyDays: [1, 2, 3, 4, 5],
    onceDate: Date.now() + 86_400_000, onceTime: 9 * 3_600_000
  }
  editId.value = null
}

// ─── Time helpers ──────────────────────────────────────────────────────

function timeToHM(ms: number): { hour: number; min: number } {
  const totalMin = Math.round(ms / 60_000)
  return { hour: Math.floor(totalMin / 60) % 24, min: totalMin % 60 }
}

function hmToTime(hour: number, min: number): number {
  return (hour * 60 + min) * 60_000
}

// ─── ID generator ───────────────────────────────────────────────────────

function genCronId(): string {
  const rand = Math.random().toString(36).slice(2, 8)
  return `Cron-${rand}`
}

// ─── Build scheduleInput from pickers ────────────────────────────────────

function buildScheduleInput(): string {
  const s = form.value
  if (s.scheduleType === 'daily') {
    const { hour, min } = timeToHM(s.dailyTime)
    const minStr = String(min).padStart(2, '0')
    const hourStr = String(hour).padStart(2, '0')
    const dow = s.dailyDays.length === 7 ? '*' : s.dailyDays.sort((a, b) => a - b).join(',')
    return `${minStr} ${hourStr} * * ${dow}`
  }
  if (s.scheduleType === 'hourly') {
    const interval = Math.max(1, Math.min(24, Math.round(s.hourlyInterval)))
    if (s.hourlyDays.length === 7) {
      return `0 */${interval} * * *`
    }
    const dow = s.hourlyDays.sort((a, b) => a - b).join(',')
    return `0 */${interval} * * ${dow}`
  }
  const d = new Date(s.onceDate)
  const { hour, min } = timeToHM(s.onceTime)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const hourStr = String(hour).padStart(2, '0')
  const minStr = String(min).padStart(2, '0')
  return `${year}-${month}-${day}T${hourStr}:${minStr}`
}

// ─── Parse existing schedule back into form for edit ─────────────────────

function parseScheduleIntoForm(job: CronJobDTO): void {
  const s = job.schedule
  if (s.kind === 'cron' && s.expr) {
    const parts = s.expr.trim().split(/\s+/)
    if (parts.length === 5) {
      const [min, hour, , , dow] = parts
      const dailyMin = parseInt(min, 10)
      const dailyHour = parseInt(hour, 10)
      if (!isNaN(dailyMin) && !isNaN(dailyHour) && dow !== '*') {
        form.value.scheduleType = 'daily'
        form.value.dailyTime = hmToTime(dailyHour, dailyMin)
        form.value.dailyDays = parseDow(dow)
        return
      }
      const stepMatch = hour.match(/^\*\/(\d+)$/)
      if (stepMatch && min === '0') {
        form.value.scheduleType = 'hourly'
        form.value.hourlyInterval = parseInt(stepMatch[1], 10)
        form.value.hourlyDays = dow === '*' ? [0, 1, 2, 3, 4, 5, 6] : parseDow(dow)
        return
      }
    }
  }
  if (s.kind === 'interval') {
    const hours = Math.round(s.minutes / 60)
    form.value.scheduleType = 'hourly'
    form.value.hourlyInterval = Math.max(1, Math.min(24, hours || 1))
    form.value.hourlyDays = [0, 1, 2, 3, 4, 5, 6]
    return
  }
  if (s.kind === 'once' && s.runAt) {
    const d = new Date(s.runAt)
    if (!isNaN(d.getTime())) {
      form.value.scheduleType = 'once'
      form.value.onceDate = d.getTime()
      form.value.onceTime = hmToTime(d.getHours(), d.getMinutes())
      return
    }
  }
  form.value.scheduleType = 'daily'
}

function parseDow(dow: string): number[] {
  try {
    const out: number[] = []
    for (const part of dow.split(',')) {
      const trimmed = part.trim()
      if (trimmed === '*' || trimmed === '0,1,2,3,4,5,6') return [0, 1, 2, 3, 4, 5, 6]
      if (trimmed.includes('-')) {
        const [a, b] = trimmed.split('-').map(Number)
        for (let i = a; i <= b; i++) out.push(i)
      } else {
        const n = parseInt(trimmed, 10)
        if (!isNaN(n)) out.push(n)
      }
    }
    return out.length > 0 ? out : [1, 2, 3, 4, 5]
  } catch {
    return [1, 2, 3, 4, 5]
  }
}

// ─── Form actions ───────────────────────────────────────────────────────

async function openCreate(): Promise<void> {
  resetForm()
  await loadAgents()
  showForm.value = true
}

async function openEdit(job: CronJobDTO): Promise<void> {
  resetForm()
  await loadAgents()
  form.value.name = job.name
  form.value.prompt = job.prompt
  form.value.enabledToolsets = (job.enabledToolsets ?? []).join(', ')
  form.value.workdir = job.workdir ?? ''
  form.value.paused = job.paused
  form.value.agentId = job.agentId ?? ''
  if (form.value.agentId) await loadSessions()
  form.value.sessionId = job.sessionId ?? ''
  parseScheduleIntoForm(job)
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

  const scheduleInput = buildScheduleInput()

  try {
    const result = editId.value
      ? await window.api.cron.update({
          id: editId.value,
          patch: {
            name: form.value.name,
            prompt: form.value.prompt,
            scheduleInput,
            enabledToolsets: enabled,
            workdir: form.value.workdir || undefined,
            agentId: form.value.agentId || undefined,
            sessionId: form.value.sessionId || undefined,
            paused: form.value.paused
          }
        })
      : await window.api.cron.create({
          id: genCronId(),
          name: form.value.name,
          prompt: form.value.prompt,
          scheduleInput,
          enabledToolsets: enabled,
          workdir: form.value.workdir || undefined,
          agentId: form.value.agentId || undefined,
          sessionId: form.value.sessionId || undefined
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
  if (s.kind === 'cron') {
    if (s.display) return s.display
    return `cron: ${s.expr}`
  }
  if (s.kind === 'interval') {
    const m = s.minutes ?? 0
    return m < 60 ? `每 ${m} 分钟` : m < 1440 ? `每 ${Math.floor(m / 60)} 小时` : `每 ${Math.floor(m / 1440)} 天`
  }
  if (s.kind === 'once') {
    if (s.display) return s.display
    const d = s.runAt ? new Date(s.runAt) : null
    return d && !isNaN(d.getTime()) ? d.toLocaleString() : '单次'
  }
  return '单次'
}

const nextRunDisplay = (iso: string | null): string => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (d.getFullYear() > 9000) return '不会再次运行'
  return d.toLocaleString()
}

const lastRunDisplay = (job: CronJobDTO): string => {
  if (!job.lastRunAt) return '—'
  const ok = job.consecutiveFailures === 0
  const icon = ok ? '✓' : '✗'
  return `${icon} ${new Date(job.lastRunAt).toLocaleString()}`
}

// ─── Weekday toggle ──────────────────────────────────────────────────────

const allDays = [0, 1, 2, 3, 4, 5, 6]

function toggleAllDays(key: 'dailyDays' | 'hourlyDays'): void {
  if (form.value[key].length === 7) {
    form.value[key] = []
  } else {
    form.value[key] = [...allDays]
  }
}

function isAllSelected(key: 'dailyDays' | 'hourlyDays'): boolean {
  return form.value[key].length === 7
}

function onDayChange(key: 'dailyDays' | 'hourlyDays', dayVal: number, checked: boolean): void {
  if (checked) {
    if (!form.value[key].includes(dayVal)) form.value[key].push(dayVal)
  } else {
    form.value[key] = form.value[key].filter((x) => x !== dayVal)
  }
}

// ─── Columns ────────────────────────────────────────────────────────────

const columns: DataTableColumns<CronJobDTO> = [
  { title: '名称', key: 'name', width: 120 },
  {
    title: '调度', key: 'schedule', width: 130,
    render: (row) => scheduleDisplay(row)
  },
  {
    title: '目标会话', key: 'sessionTitle', width: 135,
    render: (row) => {
      if (!row.sessionId) {
        return h(NText, { depth: '3', style: 'font-size:11px; font-style:italic' }, () => '自动创建')
      }
      const title = row.sessionTitle ?? row.sessionId
      const deleted = title.startsWith('[已删除]')
      return h(NText, {
        depth: '3',
        type: deleted ? 'warning' : undefined,
        style: deleted ? 'font-size:11px; font-style:italic' : 'font-size:12px'
      }, () => title)
    }
  },
  {
    title: '下次运行', key: 'nextRunAt', width: 150,
    render: (row) => nextRunDisplay(row.nextRunAt)
  },
  {
    title: '上次运行', key: 'lastRunAt', width: 150,
    render: (row) => lastRunDisplay(row)
  },
  {
    title: '状态', key: 'paused', width: 70,
    render: (row) =>
      h(NTag, { type: row.paused ? 'warning' : 'success', size: 'small' }, () =>
        row.paused ? '已暂停' : '运行中'
      )
  },
  {
    title: '操作', key: 'actions', width: 270,
    render: (row) =>
      h(NSpace, { size: 'small' }, () => [
        h(NButton, { size: 'tiny', onClick: () => openEdit(row) }, () => '编辑'),
        h(NButton, { size: 'tiny', onClick: () => runNow(row.id) }, () => '立即运行'),
        h(NButton, { size: 'tiny', onClick: () => openHistory(row.id) }, () => '运行历史'),
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
      style="width: 600px; max-width: 94vw"
      @update:show="(s) => { if (!s) closeForm() }"
    >
      <NForm label-placement="left" label-width="80">
        <NFormItem v-if="editId" label="ID">
          <NText code style="font-size:12px; user-select:all">{{ editId }}</NText>
        </NFormItem>
        <NFormItem label="名称" required>
          <NInput v-model:value="form.name" placeholder="任务显示名称" />
        </NFormItem>
        <NFormItem label="智能体">
          <NSelect
            v-model:value="form.agentId"
            :options="agents.map(a => ({ label: a.name, value: a.id }))"
            placeholder="选择智能体（默认第一个）"
            clearable
            @update:value="() => { form.sessionId = ''; loadSessions() }"
          />
        </NFormItem>
        <NFormItem label="目标会话">
          <NSelect
            v-model:value="form.sessionId"
            :options="sessions.map(s => ({ label: s.title, value: s.id }))"
            placeholder="留空则每次运行时自动创建新会话"
            clearable
            :disabled="!form.agentId"
          />
          <NText depth="3" style="font-size: 11px; margin-top: 4px">
            选择会话后，定时消息将以用户身份推送到该会话中；留空则每次运行自动创建新会话
          </NText>
        </NFormItem>

        <!-- Schedule -->
        <NFormItem label="调度" required>
          <NSpace vertical style="width:100%">
            <NSelect
              v-model:value="form.scheduleType"
              :options="scheduleTypeOptions"
              style="width:100px"
            />

            <!-- 每天 -->
            <template v-if="form.scheduleType === 'daily'">
              <NSpace align="center">
                <NText depth="3" style="font-size:13px">每天</NText>
                <NTimePicker v-model:value="form.dailyTime" format="HH:mm" style="width:110px" />
              </NSpace>
              <div style="margin-top:6px; display:flex; align-items:center; gap:4px; flex-wrap:wrap">
                <NButton
                  size="tiny"
                  secondary
                  :type="isAllSelected('dailyDays') ? 'primary' : 'default'"
                  @click="toggleAllDays('dailyDays')"
                >
                  {{ isAllSelected('dailyDays') ? '取消全选' : '全选' }}
                </NButton>
                <NCheckbox
                  v-for="d in WEEKDAYS" :key="d.value"
                  :checked="form.dailyDays.includes(d.value)"
                  :label="d.label"
                  style="margin-right: 2px; font-size: 12px"
                  @update:checked="(v) => onDayChange('dailyDays', d.value, v)"
                />
              </div>
            </template>

            <!-- 每小时 -->
            <template v-if="form.scheduleType === 'hourly'">
              <NSpace align="center">
                <NText depth="3" style="font-size:13px">每隔</NText>
                <NInputNumber v-model:value="form.hourlyInterval" :min="1" :max="24" :step="1" style="width:70px" />
                <NText depth="3" style="font-size:13px">小时</NText>
              </NSpace>
              <div style="margin-top:6px; display:flex; align-items:center; gap:4px; flex-wrap:wrap">
                <NButton
                  size="tiny"
                  secondary
                  :type="isAllSelected('hourlyDays') ? 'primary' : 'default'"
                  @click="toggleAllDays('hourlyDays')"
                >
                  {{ isAllSelected('hourlyDays') ? '取消全选' : '全选' }}
                </NButton>
                <NCheckbox
                  v-for="d in WEEKDAYS" :key="d.value"
                  :checked="form.hourlyDays.includes(d.value)"
                  :label="d.label"
                  style="margin-right: 2px; font-size: 12px"
                  @update:checked="(v) => onDayChange('hourlyDays', d.value, v)"
                />
              </div>
            </template>

            <!-- 某时（一次性） -->
            <template v-if="form.scheduleType === 'once'">
              <NSpace vertical style="width:100%">
                <NSpace align="center">
                  <NText depth="3" style="font-size:13px">日期</NText>
                  <NDatePicker
                    v-model:value="form.onceDate"
                    type="date"
                    :is-date-disabled="(ts) => ts < Date.now() - 86400000"
                    style="width:180px"
                  />
                  <NTimePicker v-model:value="form.onceTime" format="HH:mm" style="width:110px" />
                </NSpace>
                <NText depth="3" style="font-size:11px">
                  将在 {{ new Date(form.onceDate).toLocaleDateString() }} {{ String(timeToHM(form.onceTime).hour).padStart(2,'0') }}:{{ String(timeToHM(form.onceTime).min).padStart(2,'0') }} 执行一次
                </NText>
              </NSpace>
            </template>
          </NSpace>
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
          <NInput v-model:value="form.workdir" placeholder="绝对路径。留空则使用智能体的默认工作目录" />
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

    <!-- Run history modal -->
    <NModal
      :show="historyJobId !== null"
      preset="card"
      title="运行历史"
      style="width: 720px; max-width: 94vw"
      @update:show="(s) => { if (!s) { historyJobId = null; viewingHistoryContent = null } }"
    >
      <NDataTable
        v-if="!viewingHistoryContent"
        :columns="[
          { title: '时间', key: 'timestamp', width: 170, render: (r) => new Date(r.timestamp).toLocaleString() },
          { title: '状态', key: 'success', width: 70, render: (r) => h(NTag, { type: r.success ? 'success' : 'error', size: 'small' }, () => r.success ? '成功' : '失败') },
          { title: '内容摘要', key: 'content', ellipsis: { tooltip: true }, render: (r) => r.content.slice(0, 120).replace(/\n/g, ' ') },
          { title: '操作', key: 'actions', width: 80, render: (r) => h(NButton, { size: 'tiny', onClick: () => viewingHistoryContent = r.content }, () => '查看') }
        ]"
        :data="historyEntries"
        :bordered="false"
        size="small"
        :loading="historyLoading"
        :row-key="(r) => r.fileName"
      >
        <template #empty>
          <NEmpty description="暂无运行记录" />
        </template>
      </NDataTable>
      <div v-else>
        <NButton size="small" @click="viewingHistoryContent = null" style="margin-bottom:8px">← 返回列表</NButton>
        <pre class="history-content">{{ viewingHistoryContent }}</pre>
      </div>
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
.history-content {
  white-space: pre-wrap;
  word-break: break-word;
  font-family: 'Cascadia Code', Consolas, monospace;
  font-size: 12px;
  line-height: 1.5;
  background: #0d1117;
  padding: 16px;
  border-radius: 8px;
  max-height: 60vh;
  overflow-y: auto;
  margin: 0;
}
</style>

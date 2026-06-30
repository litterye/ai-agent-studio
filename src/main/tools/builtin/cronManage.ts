import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'
import { jobStore } from '../../cron/store'
import { runJob } from '../../cron/runner'
import { getStatus } from '../../cron/scheduler'

/**
 * Model-facing cron management tool — Hermes parity.
 *
 * Exposes a single `cron_manage` tool with action-style operations so the
 * agent can introspect and control its own scheduled jobs.
 *
 * In Hermes this is `cronjob_tools.py` → single `cronjob` tool with
 * create/list/update/pause/resume/run/remove/status actions.
 */

const SCHEDULE_EXAMPLES = [
  '0 9 * * *           → 每天 9:00',
  '*/30 * * * *        → 每 30 分钟',
  '0 9 * * 1-5         → 工作日 9:00',
  'every 2h            → 每 2 小时',
  'every 30m           → 每 30 分钟',
  '30m                 → 30 分钟后（一次性）',
  '2026-07-01T08:00    → 指定时间（一次性）'
].join('\n')

const schema = z.object({
  action: z
    .enum(['list', 'status', 'run', 'create', 'update', 'pause', 'resume', 'remove'])
    .describe(
      'list: show all cron jobs. status: scheduler health + summary. ' +
      'run: trigger a job immediately. create: schedule a new job. ' +
      'update: edit an existing job. pause/resume: toggle a job. ' +
      'remove: permanently delete a job.'
    ),
  // ── create / update fields ──────────────────────────────────────────
  name: z.string().optional().describe('Display name for the job (create/update).'),
  schedule: z.string().optional().describe(
    `When to run. Formats:\n${SCHEDULE_EXAMPLES}`
  ),
  prompt: z.string().optional().describe('The task to execute — a self-contained instruction (create/update).'),
  workdir: z.string().optional().describe('Working directory for the job (create/update).'),
  // ── target fields ────────────────────────────────────────────────────
  job_id: z.string().optional().describe('Job ID (required for update/pause/resume/run/remove).'),
  // ── filter fields ────────────────────────────────────────────────────
  show_paused: z.boolean().optional().describe('Include paused jobs in list (default false).')
})

type Input = z.infer<typeof schema>

const def: BuiltinToolDef<Input> = {
  name: 'cron_manage',
  description:
    'Manage scheduled (cron) jobs. Use this to list, create, update, pause, resume, ' +
    'run, or remove automated tasks. ' +
    'The user can ask you to schedule recurring work (daily summaries, monitoring, ' +
    'reminders) or one-shot delayed tasks — this tool handles all of it. ' +
    'Use "list" to see what jobs already exist, "status" to check scheduler health, ' +
    '"create" to add a new job, and "run" to trigger one immediately.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'status', 'run', 'create', 'update', 'pause', 'resume', 'remove'],
        description: 'Operation to perform.'
      },
      name: { type: 'string', description: 'Display name for the job (create/update).' },
      schedule: {
        type: 'string',
        description: `Schedule expression. Examples:\n${SCHEDULE_EXAMPLES}`
      },
      prompt: { type: 'string', description: 'Self-contained task instruction (create/update).' },
      workdir: { type: 'string', description: 'Working directory (create/update).' },
      job_id: { type: 'string', description: 'Job ID (required for update/pause/resume/run/remove).' },
      show_paused: { type: 'boolean', description: 'Include paused jobs in list.' }
    },
    required: ['action'],
    additionalProperties: false
  },
  toolset: 'cron',
  needsConfirmation: true, // destructive actions (create/remove/run) need confirmation
  emoji: '⏰',
  maxResultSizeChars: 15_000,
  async handler(input) {
    switch (input.action) {
      // ── list ──────────────────────────────────────────────────────────
      case 'list': {
        const all = jobStore.list()
        const filtered = input.show_paused ? all : all.filter((j) => !j.paused)
        if (filtered.length === 0) {
          return 'No cron jobs found. Use "create" to schedule one.'
        }
        const lines = filtered.map((j) => {
          const status = j.paused ? '⏸ 已暂停' : '▶ 运行中'
          const lastRun = j.lastRunAt
            ? new Date(j.lastRunAt).toLocaleString()
            : '从未运行'
          const nextRun = j.nextRunAt
            ? new Date(j.nextRunAt).toLocaleString()
            : '—'
          const lastResult = j.lastResult
            ? j.lastResult.slice(0, 80) + (j.lastResult.length > 80 ? '…' : '')
            : '—'
          const fails = j.consecutiveFailures > 0
            ? ` ⚠连续失败 ${j.consecutiveFailures} 次`
            : ''
          return [
            `### ${j.name}`,
            `- ID: \`${j.id}\``,
            `- 调度: ${j.schedule.kind === 'cron' ? `cron \`${(j.schedule as any).expr}\`` : j.schedule.kind === 'interval' ? `每 ${(j.schedule as any).minutes} 分钟` : `一次性 @ ${(j.schedule as any).runAt ? new Date((j.schedule as any).runAt).toLocaleString() : '?'}`}`,
            `- 状态: ${status}${fails}`,
            `- 上次运行: ${lastRun}`,
            `- 下次运行: ${nextRun}`,
            `- 上次结果: ${lastResult}`,
            j.workdir ? `- 工作目录: ${j.workdir}` : '',
            `- 提示词: ${j.prompt.slice(0, 100)}${j.prompt.length > 100 ? '…' : ''}`
          ].filter(Boolean).join('\n')
        })
        return `## 定时任务列表 (${filtered.length} 个)\n\n${lines.join('\n\n')}`
      }

      // ── status ────────────────────────────────────────────────────────
      case 'status': {
        const s = getStatus()
        const all = jobStore.list()
        const active = all.filter((j) => !j.paused)
        const paused = all.filter((j) => j.paused)
        const failing = all.filter((j) => j.consecutiveFailures > 0)
        return [
          '## 定时调度器状态',
          '',
          `- 调度器: ${s.running ? '✅ 运行中' : '❌ 已停止'}`,
          `- 心跳: ${s.tickerHeartbeat ? new Date(s.tickerHeartbeat).toLocaleString() : '—'}`,
          `- 上次成功检查: ${s.tickerLastSuccess ? new Date(s.tickerLastSuccess).toLocaleString() : '—'}`,
          '',
          `| 指标 | 数量 |`,
          `|------|------|`,
          `| 总任务 | ${all.length} |`,
          `| 活跃 | ${active.length} |`,
          `| 已暂停 | ${paused.length} |`,
          `| 有失败 | ${failing.length} |`
        ].join('\n')
      }

      // ── run ───────────────────────────────────────────────────────────
      case 'run': {
        if (!input.job_id) return 'Error: "job_id" is required for run.'
        const job = jobStore.get(input.job_id)
        if (!job) return `Error: job "${input.job_id}" not found.`
        // Trigger asynchronously — don't await, the agent should report
        // that the job has been queued.
        void runJob(input.job_id).catch((err) =>
          console.error(`[cron_manage] run ${input.job_id} failed:`, err)
        )
        return `Job "${job.name}" (\`${input.job_id}\`) has been queued for immediate execution. Check back with "list" or "status" to see results.`
      }

      // ── create ────────────────────────────────────────────────────────
      case 'create': {
        if (!input.name) return 'Error: "name" is required for create.'
        if (!input.schedule) return 'Error: "schedule" is required for create.'
        if (!input.prompt) return 'Error: "prompt" is required for create.'

        const id = 'Cron-' + Math.random().toString(36).slice(2, 8)
        const result = jobStore.create({
          id,
          name: input.name,
          prompt: input.prompt,
          scheduleInput: input.schedule,
          workdir: input.workdir
        })

        if (typeof result === 'string') {
          return `Error creating job: ${result}`
        }

        const nextRun = result.nextRunAt
          ? new Date(result.nextRunAt).toLocaleString()
          : '待计算'
        return [
          `✅ 定时任务已创建:`,
          `- ID: \`${result.id}\``,
          `- 名称: ${result.name}`,
          `- 调度: ${input.schedule}`,
          `- 下次运行: ${nextRun}`,
          `- 提示词: ${input.prompt.slice(0, 100)}${input.prompt.length > 100 ? '…' : ''}`,
          '',
          '提示: 创建后任务会自动按调度执行。如需立即测试，使用 action="run"。'
        ].join('\n')
      }

      // ── update ────────────────────────────────────────────────────────
      case 'update': {
        if (!input.job_id) return 'Error: "job_id" is required for update.'
        const patch: any = {}
        if (input.name !== undefined) patch.name = input.name
        if (input.schedule !== undefined) patch.scheduleInput = input.schedule
        if (input.prompt !== undefined) patch.prompt = input.prompt
        if (input.workdir !== undefined) patch.workdir = input.workdir

        if (Object.keys(patch).length === 0) {
          return 'Error: at least one of name/schedule/prompt/workdir must be provided for update.'
        }

        const result = jobStore.update(input.job_id, patch)
        if (typeof result === 'string') {
          return `Error updating job: ${result}`
        }

        const nextRun = result.nextRunAt
          ? new Date(result.nextRunAt).toLocaleString()
          : '待计算'
        return [
          `✅ 任务已更新:`,
          `- ID: \`${result.id}\``,
          `- 名称: ${result.name}`,
          `- 下次运行: ${nextRun}`,
        ].join('\n')
      }

      // ── pause ───────────────────────────────────────────────────────
      case 'pause': {
        if (!input.job_id) return 'Error: "job_id" is required for pause.'
        const result = jobStore.update(input.job_id, { paused: true })
        if (typeof result === 'string') return `Error: ${result}`
        return `⏸ 任务 "${result.name}" (\`${input.job_id}\`) 已暂停。使用 action="resume" 恢复。`
      }

      // ── resume ──────────────────────────────────────────────────────
      case 'resume': {
        if (!input.job_id) return 'Error: "job_id" is required for resume.'
        const result = jobStore.update(input.job_id, { paused: false })
        if (typeof result === 'string') return `Error: ${result}`
        const nextRun = result.nextRunAt
          ? new Date(result.nextRunAt).toLocaleString()
          : '待计算'
        return `▶ 任务 "${result.name}" (\`${input.job_id}\`) 已恢复。下次运行: ${nextRun}`
      }

      // ── remove ─────────────────────────────────────────────────────
      case 'remove': {
        if (!input.job_id) return 'Error: "job_id" is required for remove.'
        const job = jobStore.get(input.job_id)
        if (!job) return `Error: job "${input.job_id}" not found.`
        jobStore.remove(input.job_id)
        return `🗑 任务 "${job.name}" (\`${input.job_id}\`) 已永久删除。`
      }

      default:
        return `Unknown action: ${(input as any).action}`
    }
  }
}

export function createCronManageTool(): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.jsonSchema,
    source: 'builtin',
    toolset: def.toolset,
    needsConfirmation: def.needsConfirmation ?? false,
    emoji: def.emoji,
    maxResultSizeChars: def.maxResultSizeChars,
    async run(input: unknown): Promise<string> {
      return def.handler(def.schema.parse(input))
    }
  }
}

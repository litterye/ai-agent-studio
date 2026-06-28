import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { paths, ensureDir } from '../approvals/paths'
import { jobStore } from './store'
import { agentService } from '../agent/AgentService'
import type { AgentEvent } from '@shared/ipc'

/**
 * Run a cron job via `AgentService.run()` with callbacks that write results
 * to disk and emit CRON_EVENT to the renderer (if a window is open).
 */

export interface CronRunResult {
  output: string
  error?: string
  consecutiveFailures: number
}

export async function runJob(jobId: string): Promise<CronRunResult> {
  const job = jobStore.get(jobId)
  if (!job) {
    return { output: '', error: `Job "${jobId}" not found.`, consecutiveFailures: 0 }
  }

  const runId = `cron__${jobId}__${randomUUID()}`
  let output = ''
  let error: string | undefined

  try {
    await agentService.run(
      runId,
      [{ role: 'user', content: job.prompt }],
      {
        emit: (e: AgentEvent) => {
          if (e.type === 'text_delta') {
            output += e.text
            if (output.length > 100_000) output = output.slice(0, 100_000)
          }
          if (e.type === 'tool_result') {
            output += `\n→ tool: ${e.toolName} (${e.isError ? 'error' : 'ok'})`
          }
          if (e.type === 'error') {
            error = e.message
          }
        },
        isCancelled: () => false,
        confirm: async () => ({ approved: false })
      },
      null // no session key
    )

    writeOutput(jobId, output)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    output += `\n\n[Error] ${error}`
    writeOutput(jobId, output)
  }

  // Suppress delivery for [SILENT] / SILENT / NO_REPLY prefix (Hermes parity).
  const clean = output.trim()
  if (
    clean.startsWith('[SILENT]') ||
    clean.startsWith('SILENT') ||
    clean.startsWith('NO_REPLY')
  ) {
    output = '[silent — output suppressed]'
  }

  const prevFailures = job.consecutiveFailures
  const consecutiveFailures = error ? prevFailures + 1 : 0

  jobStore.stampResult(jobId, { output, error, consecutiveFailures })

  return { output, error, consecutiveFailures }
}

function writeOutput(jobId: string, output: string): void {
  const dir = join(paths.cronOutputDir, jobId)
  ensureDir(dir)
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    'T',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
  const filename = `${ts}.md`
  const abs = join(dir, filename)
  try {
    writeFileSync(abs, `# ${jobId} — ${ts}\n\n${output}`, 'utf8')
  } catch (err) {
    console.error(`[cron] failed to write output for ${jobId}:`, err)
  }
}
import { writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { BrowserWindow } from 'electron'
import { paths, ensureDir } from '../approvals/paths'
import { jobStore } from './store'
import { agentService } from '../agent/AgentService'
import { agentStore } from '../db/agentStore'
import { sessionStore } from '../db/sessionStore'
import { messageStore } from '../db/messageStore'
import { IPC, type AgentEvent, type ChatMessage } from '@shared/ipc'

/**
 * Run a cron job via `AgentService.run()` with callbacks that write results
 * to disk. If the job has a target session, messages are appended there;
 * otherwise a new session is created under the job's agent.
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

  // Resolve agent — use the job's agent, or the default agent
  const agent = (job.agentId && agentStore.getById(job.agentId)) || agentStore.getDefault()

  // Resolve workdir: job workdir > agent workspace dir
  const workdir = job.workdir || agent.workspace_dir

  // Resolve session — use the target session if it still exists, or create a new one
  let sessionId: string
  let sessionKey: string
  let history: ChatMessage[]
  let model: string
  let protocol: string

  const targetSession = job.sessionId ? sessionStore.getById(job.sessionId) : null

  if (targetSession) {
    // Existing session — load history + use its model/protocol
    sessionId = targetSession.id
    sessionKey = targetSession.id
    model = targetSession.model
    protocol = targetSession.protocol
    // Load recent messages as conversation context (last 20, which is plenty)
    const msgs = messageStore.listBySession(sessionId).slice(-20)
    history = msgs.map((m) => ({
      role: m.role,
      content: m.content
    }))
    // Append the cron prompt as a new user message to DB
    messageStore.append({
      sessionId,
      role: 'user',
      content: job.prompt
    })
    // Bump session updated_at so it moves to the top
    sessionStore.update(sessionId, {})
  } else {
    // No target session — create a new one per run
    const sess = sessionStore.create({
      agentId: agent.id,
      title: `[定时] ${job.name} — ${new Date().toLocaleDateString()}`,
      model: agent.default_model,
      protocol: agent.default_protocol
    })
    sessionId = sess.id
    sessionKey = sess.id
    model = sess.model
    protocol = sess.protocol
    // Persist the cron prompt as the first user message
    messageStore.append({
      sessionId,
      role: 'user',
      content: job.prompt
    })
    history = []
  }

  // Push the current prompt onto history for the agent run
  history.push({ role: 'user', content: job.prompt })

  const runId = `cron__${jobId}__${randomUUID()}`
  let output = ''
  let error: string | undefined

  // Pin the workdir so tools resolve relative paths correctly.
  const prevCwd = process.env['AGENT_STUDIO_CWD']
  process.env['AGENT_STUDIO_CWD'] = workdir

  try {
    await agentService.run(
      runId,
      history,
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
        // Cron jobs run headless — auto-approve all tool confirmations.
        confirm: async () => ({ approved: true })
      },
      sessionKey,
      sessionId,
      { model, protocol },
      true // isCron — tells the agent this is a headless scheduled execution
    )

    // Persist assistant response to the session
    if (output) {
      messageStore.append({
        sessionId,
        role: 'assistant',
        content: output.slice(0, 100_000)
      })
      // Bump session updated_at so it appears at the top of the list
      sessionStore.update(sessionId, {})
    }

    writeOutput(jobId, output)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
    output += `\n\n[Error] ${error}`
    writeOutput(jobId, output)
  } finally {
    // Restore previous cwd
    if (prevCwd !== undefined) {
      process.env['AGENT_STUDIO_CWD'] = prevCwd
    } else {
      delete process.env['AGENT_STUDIO_CWD']
    }
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

  // Notify all renderer windows so they can refresh session list, cron list, etc.
  broadcastCronEvent({ type: 'job-completed', jobId, sessionId })

  return { output, error, consecutiveFailures }
}

function broadcastCronEvent(payload: unknown): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(IPC.CronEvent, payload)
    }
  } catch {
    /* best-effort — renderer might not be open */
  }
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
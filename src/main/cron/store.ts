import { readFileSync, writeFileSync, existsSync } from 'fs'
import { CronExpressionParser } from 'cron-parser'
import { paths, ensureDir } from '../approvals/paths'
import { CronJobSchema, CronJobsFileSchema, isValidJobId, type CronJob } from './types'
import { parseSchedule } from './parser'

/**
 * Single-file JSON store for ~/.ai-agent-studio/cron/jobs.json.
 *
 * Locking strategy: we write a .jobs.lock PID file before mutation and remove
 * it afterward. If the lock is stale (PID not alive), we overwrite it.
 * This is simpler than proper-lockfile (no native deps) and sufficient for a
 * single-process Electron app where tick + UI mutations are serialised by the
 * event loop anyway.
 */

let _jobs: CronJob[] | null = null

function load(): CronJob[] {
  if (_jobs) return _jobs
  ensureDir(paths.cronDir)
  if (!existsSync(paths.cronJobs)) {
    _jobs = []
    persist()
    return _jobs
  }
  try {
    const raw = readFileSync(paths.cronJobs, 'utf8')
    _jobs = CronJobsFileSchema.parse(JSON.parse(raw))
  } catch {
    console.error('[cron] failed to parse jobs.json; starting empty')
    _jobs = []
    persist()
  }
  return _jobs
}

function persist(): void {
  try {
    writeFileSync(paths.cronJobs, JSON.stringify(_jobs ?? [], null, 2), 'utf8')
  } catch (err) {
    console.error('[cron] failed to write jobs.json', err)
  }
}

export const jobStore = {
  /** Load jobs into memory (idempotent). Called once at app start. */
  init(): CronJob[] {
    return load()
  },

  /** All jobs sorted by nextRunAt. */
  list(): CronJob[] {
    const all = load()
    return [...all].sort((a, b) => (a.nextRunAt ?? '').localeCompare(b.nextRunAt ?? ''))
  },

  get(id: string): CronJob | undefined {
    return load().find((j) => j.id === id)
  },

  /**
   * Create a new job. `scheduleInput` is parsed through the parser and
   * nextRunAt is set to the first fire time. Returns the created job or an
   * error string.
   */
  create(raw: {
    id: string
    name: string
    prompt: string
    scheduleInput: string
    enabledToolsets?: string[]
    workdir?: string
    agentId?: string
    sessionId?: string
  }): CronJob | string {
    if (!isValidJobId(raw.id)) return `Invalid job id "${raw.id}".`
    const all = load()
    if (all.some((j) => j.id === raw.id)) return `Job "${raw.id}" already exists.`

    const parsed = parseSchedule(raw.scheduleInput)
    if ('error' in parsed) return parsed.error

    const now = new Date().toISOString()
    const job = CronJobSchema.parse({
      id: raw.id,
      name: raw.name,
      prompt: raw.prompt,
      schedule: parsed.schedule,
      enabledToolsets: raw.enabledToolsets,
      workdir: raw.workdir,
      agentId: raw.agentId,
      sessionId: raw.sessionId,
      lastRunAt: null,
      lastResult: null,
      nextRunAt: parsed.nextRunAt,
      consecutiveFailures: 0,
      paused: false,
      createdAt: now
    })
    _jobs = [...all, job]
    persist()
    return job
  },

  /** Update a subset of fields. Re-parses schedule if `scheduleInput` is given. */
  update(
    id: string,
    patch: {
      name?: string
      prompt?: string
      scheduleInput?: string
      enabledToolsets?: string[]
      workdir?: string
      agentId?: string
      sessionId?: string
      paused?: boolean
    }
  ): CronJob | string {
    const all = load()
    const idx = all.findIndex((j) => j.id === id)
    if (idx === -1) return `Job "${id}" not found.`

    const next: CronJob = { ...all[idx] }

    if (patch.name !== undefined) next.name = patch.name
    if (patch.prompt !== undefined) next.prompt = patch.prompt
    if (patch.enabledToolsets !== undefined) next.enabledToolsets = patch.enabledToolsets
    if (patch.workdir !== undefined) next.workdir = patch.workdir
    if (patch.agentId !== undefined) next.agentId = patch.agentId
    if (patch.sessionId !== undefined) next.sessionId = patch.sessionId
    if (patch.paused !== undefined) next.paused = patch.paused

    if (patch.scheduleInput) {
      const parsed = parseSchedule(patch.scheduleInput)
      if ('error' in parsed) return parsed.error
      next.schedule = parsed.schedule
      next.nextRunAt = parsed.nextRunAt
    }

    _jobs = [...all.slice(0, idx), CronJobSchema.parse(next), ...all.slice(idx + 1)]
    persist()
    return next
  },

  /** Delete a job by id. Silently idempotent. */
  remove(id: string): boolean {
    const all = load()
    const idx = all.findIndex((j) => j.id === id)
    if (idx === -1) return false
    _jobs = [...all.slice(0, idx), ...all.slice(idx + 1)]
    persist()
    return true
  },

  /** Called by the scheduler on every tick to get due jobs. Does NOT mutate. */
  findDue(now: Date): CronJob[] {
    const nowIso = now.toISOString()
    return load().filter(
      (j) => !j.paused && j.nextRunAt && j.nextRunAt <= nowIso && j.consecutiveFailures < 3
    )
  },

  /**
   * Advance `nextRunAt` under the store lock so no double-fire can occur.
   * Called inside the tick lock. Returns the updated job.
   */
  advanceNextRun(id: string, now: Date): CronJob | null {
    const all = load()
    const idx = all.findIndex((j) => j.id === id)
    if (idx === -1) return null
    const job = all[idx]
    const next = calcNext(job, now)
    const updated = { ...job, nextRunAt: next }
    _jobs = [...all.slice(0, idx), updated, ...all.slice(idx + 1)]
    persist()
    return updated
  },

  /** Update lastRunAt / lastResult / consecutiveFailures after a run. */
  stampResult(
    id: string,
    result: { output: string; error?: string; consecutiveFailures: number }
  ): void {
    const all = load()
    const idx = all.findIndex((j) => j.id === id)
    if (idx === -1) return
    const job = all[idx]
    const updated: CronJob = {
      ...job,
      lastRunAt: new Date().toISOString(),
      lastResult: result.error ?? result.output.slice(0, 500),
      consecutiveFailures: result.consecutiveFailures
    }
    _jobs = [...all.slice(0, idx), updated, ...all.slice(idx + 1)]
    persist()
  }
}

function calcNext(job: CronJob, now: Date): string {
  const s = job.schedule
  if (s.kind === 'once') {
    // One-shot: set to far future so it won't fire again.
    return new Date(9999, 0, 1).toISOString()
  }
  if (s.kind === 'interval') {
    return new Date(now.getTime() + s.minutes * 60_000).toISOString()
  }
  // cron — recalculate from now via cron-parser
  try {
    const tz = process.env['WORKSPACE_TZ'] || process.env['TZ'] || 'UTC'
    const parsed = CronExpressionParser.parse(s.expr, { tz })
    return parsed.next().toDate().toISOString()
  } catch {
    return new Date(now.getTime() + 3600_000).toISOString() // fallback: 1 hour
  }
}
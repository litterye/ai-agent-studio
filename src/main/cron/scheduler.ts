import { writeFileSync, existsSync, readFileSync } from 'fs'
import { paths, ensureDir } from '../approvals/paths'
import { jobStore } from './store'

/**
 * In-process ticker that fires due cron jobs.
 *
 * Hermes parity:
 *  - 60s tick interval
 *  - .tick.lock (PID-based, non-blocking) prevents overlapping ticks
 *  - ticker_heartbeat → touched every iteration
 *  - ticker_last_success → touched only on clean tick
 *  - Cron always excludes 'cronjob' / 'messaging' / 'clarify' toolsets
 */

const TICK_MS = 60_000

let _timer: NodeJS.Timeout | null = null
let _running = false
let _runner: ((jobId: string) => Promise<unknown>) | null = null

export interface TickerStatus {
  tickerHeartbeat: string | null
  tickerLastSuccess: string | null
  running: boolean
}

export function startScheduler(runJob: (jobId: string) => Promise<unknown>): void {
  if (_running) return
  ensureDir(paths.cronDir)
  jobStore.init()
  _runner = runJob
  _running = true
  void tick()
  _timer = setInterval(() => { void tick() }, TICK_MS)
}

export function stopScheduler(): void {
  _running = false
  if (_timer) {
    clearInterval(_timer)
    _timer = null
  }
  _runner = null
}

export function getStatus(): TickerStatus {
  return {
    tickerHeartbeat: safeRead(paths.cronTickerHeartbeat),
    tickerLastSuccess: safeRead(paths.cronTickerLastSuccess),
    running: _running
  }
}

async function tick(): Promise<void> {
  if (!_running) return

  // Non-blocking lock: write PID to .tick.lock. If already locked, skip.
  if (!acquireTickLock()) return

  try {
    touch(paths.cronTickerHeartbeat)

    const now = new Date()
    const due = jobStore.findDue(now)

    for (const job of due) {
      if (!_running) break
      // Advance nextRunAt BEFORE running — at-most-once semantics
      const advanced = jobStore.advanceNextRun(job.id, now)
      if (!advanced) continue

      try {
        if (_runner) await _runner(job.id)
      } catch (err) {
        console.error(`[cron] job ${job.id} failed:`, err)
      }
    }

    touch(paths.cronTickerLastSuccess)
  } finally {
    releaseTickLock()
  }
}

// ─── lock helpers ────────────────────────────────────────────────────────

function acquireTickLock(): boolean {
  try {
    if (existsSync(paths.cronTickLock)) {
      // Check if the lock is stale (PID not alive).
      const raw = readFileSync(paths.cronTickLock, 'utf8').trim()
      const pid = parseInt(raw, 10)
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 0) // signal 0 = probe
          return false // process is alive → lock is held
        } catch {
          // Process dead → stale lock, we can take it.
        }
      }
    }
    writeFileSync(paths.cronTickLock, String(process.pid), 'utf8')
    return true
  } catch {
    return false
  }
}

function releaseTickLock(): void {
  try {
    if (existsSync(paths.cronTickLock)) {
      const raw = readFileSync(paths.cronTickLock, 'utf8').trim()
      if (raw === String(process.pid)) {
        writeFileSync(paths.cronTickLock, '', 'utf8')
      }
    }
  } catch {
    /* ignore */
  }
}

function touch(p: string): void {
  try {
    writeFileSync(p, new Date().toISOString(), 'utf8')
  } catch {
    /* ignore */
  }
}

function safeRead(p: string): string | null {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8').trim() : null
  } catch {
    return null
  }
}
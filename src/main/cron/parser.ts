import { CronExpressionParser } from 'cron-parser'
import type { CronSchedule } from './types'

/**
 * Parse user-facing schedule descriptions into the CronSchedule union.
 * Accepts the same five shapes Hermes accepts:
 *   "30m" / "2h" / "1d" → one-shot
 *   "every 30m" → recurring interval
 *   "0 9 * * *" → cron expression
 *   "2026-02-03T14:00" / "2026-02-03 14:00" → ISO one-shot
 *
 * Anchored to WORKSPACE_TZ env var (default "UTC").
 */

export interface ParseResult {
  schedule: CronSchedule
  /** ISO timestamp for the next fire (used by store/scheduler). */
  nextRunAt: string
  /** Human display (characters only, no markdown). */
  display: string
}

export interface ParseError {
  error: string
}

const TZ = process.env['WORKSPACE_TZ'] || process.env['TZ'] || 'UTC'

export function parseSchedule(input: string): ParseResult | ParseError {
  const norm = input.trim()
  if (!norm) return { error: 'Empty schedule.' }

  // 1. ISO datetime: 2026-02-03T14:00 or 2026-02-03 14:00
  const isoMatch = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(norm)
  if (isoMatch) {
    const dt = new Date(norm.replace(' ', 'T'))
    if (isNaN(dt.getTime())) return { error: `Invalid date: ${norm}` }
    return {
      schedule: { kind: 'once', runAt: dt.toISOString(), display: dt.toLocaleString() },
      nextRunAt: dt.toISOString(),
      display: dt.toLocaleString()
    }
  }

  // 2. "every Nm" → interval
  const intervalMatch = norm.match(/^[eE]very\s+(\d+)\s*(m|min|h|d)\s*$/)
  if (intervalMatch) {
    let minutes = parseInt(intervalMatch[1], 10)
    if (isNaN(minutes) || minutes <= 0) return { error: 'Invalid interval number.' }
    const unit = intervalMatch[2]
    if (unit === 'h') minutes *= 60
    if (unit === 'd') minutes *= 1440
    if (minutes > 10080) return { error: 'Interval must not exceed 1 week (10080 min).' }
    const next = new Date(Date.now() + minutes * 60_000)
    return {
      schedule: { kind: 'interval', minutes },
      nextRunAt: next.toISOString(),
      display: `每 ${formatInterval(minutes)}`
    }
  }

  // 3. "30m" / "2h" / "1d" → one-shot relative
  const relativeMatch = norm.match(/^(\d+)\s*(m|min|h|d)\s*$/)
  if (relativeMatch) {
    let minutes = parseInt(relativeMatch[1], 10)
    if (isNaN(minutes) || minutes <= 0) return { error: 'Invalid relative time.' }
    const unit = relativeMatch[2]
    if (unit === 'h') minutes *= 60
    if (unit === 'd') minutes *= 1440
    const next = new Date(Date.now() + minutes * 60_000)
    return {
      schedule: { kind: 'once', runAt: next.toISOString() },
      nextRunAt: next.toISOString(),
      display: `一次（${formatInterval(minutes)}后）`
    }
  }

  // 4. Cron expression (5-field)
  if (norm.split(/\s+/).length === 5) {
    try {
      const parsed = CronExpressionParser.parse(norm, { tz: TZ })
      const next = parsed.next().toDate()
      return {
        schedule: { kind: 'cron', expr: norm },
        nextRunAt: next.toISOString(),
        display: `cron: ${norm}`
      }
    } catch {
      return { error: `Invalid cron expression: ${norm}` }
    }
  }

  return { error: `Cannot parse schedule: "${norm}". Try "30m", "every 30m", "0 9 * * *", or "2026-06-01T09:00".` }
}

function formatInterval(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时`
  return `${Math.floor(minutes / 1440)} 天`
}
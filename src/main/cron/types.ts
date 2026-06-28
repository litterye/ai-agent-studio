import { z } from 'zod'

/**
 * Zod schema for the on-disk `~/.ai-agent-studio/cron/jobs.json`.
 * Validates at load and on every upsert.
 */

export const CronScheduleSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('cron'),
    /** Standard 5-field cron expression (minute hour dom month dow). */
    expr: z.string().min(1),
    /** Human-friendly display, shown in the UI (e.g. "每天 9:00"). */
    display: z.string().optional()
  }),
  z.object({
    kind: z.literal('interval'),
    /** Recurring: run every N minutes. */
    minutes: z.number().int().min(1).max(10080) // 1 minute to 1 week
  }),
  z.object({
    kind: z.literal('once'),
    /** ISO-8601 timestamp for when to run exactly once. UTC recommended. */
    runAt: z.string().min(1),
    display: z.string().optional()
  })
])

export const CronJobSchema = z.object({
  id: z.string().min(1).max(128),
  /** Display name, shown in the UI. */
  name: z.string().min(1).max(200),
  /** The prompt to send as a user message. */
  prompt: z.string().min(1),
  schedule: CronScheduleSchema,
  /** Toolsets enabled for this job (defaults to platform default if empty). */
  enabledToolsets: z.array(z.string()).optional(),
  /** Working directory for the job. Defaults to user's home dir. */
  workdir: z.string().optional(),
  /** Last time this job ran (ISO timestamp, UTC). */
  lastRunAt: z.string().nullable().default(null),
  /** Last run result summary. */
  lastResult: z.string().nullable().default(null),
  /** Next scheduled run (ISO timestamp, UTC). Computed by the scheduler. */
  nextRunAt: z.string().nullable().default(null),
  /** Consecutive failure count — after 3, the scheduler skips one cycle. */
  consecutiveFailures: z.number().int().min(0).default(0),
  /** If true the scheduler skips this job. */
  paused: z.boolean().default(false),
  /** Creation time (ISO timestamp). */
  createdAt: z.string()
})

export type CronJob = z.infer<typeof CronJobSchema>
export type CronSchedule = z.infer<typeof CronScheduleSchema>

/** Disk shape: array of CronJob. */
export const CronJobsFileSchema = z.array(CronJobSchema)

/** Safe-path-identifier check — matches Hermes's cron/jobs.py validator. */
export function isValidJobId(id: string): boolean {
  if (!id || id.length > 128) return false
  // No path separators, no parent traversals, no absolute paths.
  if (id.includes('/') || id.includes('\\') || id.includes('..')) return false
  // Alphanumeric + hyphens + underscores only.
  return /^[a-zA-Z0-9_-]+$/.test(id)
}
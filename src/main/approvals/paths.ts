import { homedir } from 'os'
import { join } from 'path'
import { mkdirSync } from 'fs'

/**
 * On-disk layout for AI Agent Studio. Mirrors Hermes's ~/.hermes/ convention.
 * All paths are plain text — secrets (API keys) stay in Electron's userData
 * encrypted via safeStorage.
 *
 * Override the root with WORKSPACE_HOME for testing / portable installs.
 */
const HOME_OVERRIDE = process.env['WORKSPACE_HOME']?.trim() || null

export const studioHome: string = HOME_OVERRIDE || join(homedir(), '.ai-agent-studio')

export const paths = {
  home: studioHome,
  configDir: join(studioHome, 'config'),
  approvalsConfig: join(studioHome, 'config', 'approvals.yaml'),
  workspaceConfig: join(studioHome, 'config', 'workspace.json'),
  skillsDir: join(studioHome, 'skills'),
  skillsSnapshot: join(studioHome, 'skills', '.skills_prompt_snapshot.json'),
  cronDir: join(studioHome, 'cron'),
  cronJobs: join(studioHome, 'cron', 'jobs.json'),
  cronTickLock: join(studioHome, 'cron', '.tick.lock'),
  cronJobsLock: join(studioHome, 'cron', '.jobs.lock'),
  cronTickerHeartbeat: join(studioHome, 'cron', 'ticker_heartbeat'),
  cronTickerLastSuccess: join(studioHome, 'cron', 'ticker_last_success'),
  cronOutputDir: join(studioHome, 'cron', 'output'),
  mcpServersConfig: join(studioHome, 'config', 'mcp-servers.json'),
  dbFile: join(studioHome, 'data', 'studio.db'),
  pendingSkillsDir: join(studioHome, 'pending', 'skills'),
  pendingMemoryDir: join(studioHome, 'pending', 'memory'),
  workspaceMemoryDir: join(studioHome, 'workspace', 'memory'),
  plansDir: join(studioHome, 'plans')
} as const

/** Best-effort mkdir -p. Silently ignores EEXIST. */
export function ensureDir(dir: string): void {
  try {
    mkdirSync(dir, { recursive: true })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
}

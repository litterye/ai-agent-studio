import { readFileSync, writeFileSync, existsSync } from 'fs'
import { z } from 'zod'
import { homedir } from 'os'
import { paths, ensureDir } from '../approvals/paths'

/**
 * ~/.ai-agent-studio/config/workspace.json — plain JSON (NOT encrypted;
 * the denylist in workspace/fileSafety.ts blocks the LLM from reading it).
 */
const WorkspaceConfigSchema = z.object({
  /** Default cwd used when no per-session override is set. */
  defaultCwd: z.string().default(''),
  /** Per-conversation cwd pins, keyed by conversationId. */
  sessions: z.record(z.string(), z.string()).default({})
})

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>

const DEFAULT: WorkspaceConfig = {
  defaultCwd: homedir(),
  sessions: {}
}

let _cfg: WorkspaceConfig = { ...DEFAULT }

export function initWorkspaceConfig(): WorkspaceConfig {
  ensureDir(paths.configDir)
  if (existsSync(paths.workspaceConfig)) {
    try {
      const raw = readFileSync(paths.workspaceConfig, 'utf8')
      _cfg = WorkspaceConfigSchema.parse(JSON.parse(raw))
    } catch (err) {
      console.error('[workspace] failed to parse', paths.workspaceConfig, err)
      _cfg = { ...DEFAULT }
    }
  } else {
    persist()
  }
  return _cfg
}

export function getWorkspaceConfig(): WorkspaceConfig {
  return _cfg
}

export function setDefaultCwd(cwd: string): WorkspaceConfig {
  _cfg = { ..._cfg, defaultCwd: cwd }
  persist()
  return _cfg
}

export function setSessionCwd(sessionKey: string, cwd: string): WorkspaceConfig {
  _cfg = { ..._cfg, sessions: { ..._cfg.sessions, [sessionKey]: cwd } }
  persist()
  return _cfg
}

export function clearSessionCwd(sessionKey: string): WorkspaceConfig {
  const { [sessionKey]: _drop, ...rest } = _cfg.sessions
  _cfg = { ..._cfg, sessions: rest }
  persist()
  return _cfg
}

function persist(): void {
  try {
    writeFileSync(paths.workspaceConfig, JSON.stringify(_cfg, null, 2), 'utf8')
  } catch (err) {
    console.error('[workspace] failed to write', paths.workspaceConfig, err)
  }
}

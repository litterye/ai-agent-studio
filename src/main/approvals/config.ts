import { readFileSync, writeFileSync, existsSync } from 'fs'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { paths, ensureDir } from './paths'

/**
 * Essential toolsets that MUST always be present in the defaults.
 * The migration loop below ensures existing configs on disk are patched
 * forward when a new toolset is registered here.
 */
const REQUIRED_TOOLSETS = ['file', 'terminal', 'skills', 'web', 'browser', 'tasks']

/**
 * Zod schema for ~/.ai-agent-studio/config/approvals.yaml.
 *
 * Mirrors Hermes's approvals config (`config.yaml` `approvals:` block).
 * Unknown keys are stripped on load (passthrough would be a footgun
 * because a typo would silently have no effect).
 */
const ConfirmOverrideValue = z.enum(['always', 'never', 'ask'])
const ConfirmOverride = z.record(z.string(), ConfirmOverrideValue)

const ToolsetName = z.string().min(1)

export const ApprovalsConfigSchema = z.object({
  /** YOLO: skip all confirmations. Frozen at import — see frozenYolo.ts. */
  yoloMode: z.boolean().default(false),
  /** Cron delivery: silent writes to output dir, notify posts a system notification, interactive is forbidden in cron. */
  cronMode: z.enum(['silent', 'notify']).default('silent'),
  /** When a command matches no DANGEROUS_PATTERN but might be risky, ask an aux LLM. */
  smartApprove: z.boolean().default(true),
  memory: z
    .object({
      /** Layer C: stage memory writes to pending/memory/ for review. */
      writeApproval: z.boolean().default(false)
    })
    .default({ writeApproval: false }),
  skills: z
    .object({
      /** Layer C: stage skill writes to pending/skills/ for review. */
      writeApproval: z.boolean().default(false)
    })
    .default({ writeApproval: false }),
  toolsets: z
    .object({
      /** Default toolsets enabled when a session has no explicit override. */
      default: z.array(ToolsetName).default(REQUIRED_TOOLSETS),
      /**
       * Per-tool confirm override. 'always' = auto-allow, 'never' = auto-deny,
       * 'ask' = always confirm (overrides `needsConfirmation`).
       */
      confirmOverride: ConfirmOverride.default({})
    })
    .default({ default: REQUIRED_TOOLSETS, confirmOverride: {} })
})

export type ApprovalsConfig = z.infer<typeof ApprovalsConfigSchema>
export type Toolset = z.infer<typeof ToolsetName>

const DEFAULT_CONFIG: ApprovalsConfig = ApprovalsConfigSchema.parse({})

/**
 * Process-wide singleton. Loaded once on app start; mutated via
 * `updateApprovals()`. The on-disk file is the source of truth — restart
 * to pick up manual edits.
 */
let _config: ApprovalsConfig = DEFAULT_CONFIG

export function initApprovalsConfig(): ApprovalsConfig {
  ensureDir(paths.configDir)
  if (existsSync(paths.approvalsConfig)) {
    try {
      const raw = readFileSync(paths.approvalsConfig, 'utf8')
      const parsed = parseYaml(raw)
      _config = ApprovalsConfigSchema.parse(parsed)
      // Ensure essential toolsets are present — patches forward every time
      // REQUIRED_TOOLSETS grows, regardless of what the on-disk file lists.
      const current = _config.toolsets.default
      let mutated = false
      for (const t of REQUIRED_TOOLSETS) {
        if (!current.includes(t)) {
          _config.toolsets.default = [...current, t]
          mutated = true
        }
      }
      if (mutated) persist()
    } catch (err) {
      // Bad file: log and fall back to defaults. We do NOT overwrite —
      // the user might want to fix the file by hand.
      console.error('[approvals] failed to parse', paths.approvalsConfig, err)
      _config = DEFAULT_CONFIG
    }
  } else {
    persist()
  }
  return _config
}

export function getApprovalsConfig(): ApprovalsConfig {
  return _config
}

export function updateApprovals(partial: Partial<ApprovalsConfig>): ApprovalsConfig {
  _config = ApprovalsConfigSchema.parse({ ..._config, ...partial })
  persist()
  return _config
}

/** Apply a per-tool override without going through the full schema update. */
export function setToolOverride(toolName: string, value: 'always' | 'never' | 'ask'): void {
  _config = ApprovalsConfigSchema.parse({
    ..._config,
    toolsets: {
      ..._config.toolsets,
      confirmOverride: { ..._config.toolsets.confirmOverride, [toolName]: value }
    }
  })
  persist()
}

function persist(): void {
  try {
    writeFileSync(paths.approvalsConfig, stringifyYaml(_config), 'utf8')
  } catch (err) {
    console.error('[approvals] failed to write', paths.approvalsConfig, err)
  }
}

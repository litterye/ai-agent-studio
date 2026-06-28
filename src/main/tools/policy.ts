import type { AgentTool } from './types'
import { getApprovalsConfig } from '../approvals/config'
import { YOLO_FROZEN } from '../approvals/frozenYolo'
import { isDangerous } from '../approvals/dangerousCommands'
import { smartApprove } from '../approvals/smartApprove'
import { isWriteDenied, resolveAgentPath } from '../workspace/fileSafety'

/**
 * Hermes-style three-layer approval:
 *  - Layer A: dangerous-command regex (terminal toolset)
 *  - Layer B: write-path denylist (every file/terminal write)
 *  - Layer C: write-approval staging (skills/memory) — deferred to Phase 7
 *
 * Returns a verdict the caller can act on. `confirm` carries a `reason` so the
 * renderer can show *why* the dialog was raised (dangerous pattern, write
 * denylist, builtin default, etc.).
 */
export type PolicyDecision =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'confirm'; reason: PolicyReason }
  | { verdict: 'staged'; id: string; kind: 'skills' | 'memory' }

export interface PolicyReason {
  /** Stable rule id, suitable for renderer display ("dangerous-command", "write-denylist", "default"). */
  rule:
    | 'yolo'
    | 'dangerous-command'
    | 'smart-approve-deny'
    | 'write-denylist'
    | 'default-confirm'
    | 'toolset-disabled'
  /** Human-readable explanation. */
  message: string
  /** Optional metadata — matched pattern, denied path, etc. */
  detail?: Record<string, unknown>
}

export interface PolicyContext {
  /** Active toolsets for the session — drives the toolset-disabled rule. */
  activeToolsets: Set<string>
  /** Active session cwd (for resolving relative paths before denylist check). */
  cwd?: string
}

/**
 * Evaluate policy for a tool call. Order matters:
 *  1. YOLO: short-circuit allow (env-frozen).
 *  2. Toolset gate: if the tool's toolset is not active for this session, deny.
 *  3. Per-tool confirmOverride: 'always' = allow, 'never' = deny, 'ask' = confirm.
 *  4. Layer A (terminal only): dangerous-command regex → confirm; smartApprove
 *     fallback if smart-approve is enabled and the regex didn't match.
 *  5. Layer B: write-path denylist on every write-style tool.
 *  6. Builtin default: needsConfirmation → confirm.
 *
 * Layer C (skills/memory staging) is hooked in `evaluateStaged` separately so
 * the agent loop can short-circuit before the tool actually runs.
 */
export async function evaluatePolicy(
  tool: AgentTool,
  input: unknown,
  ctx: PolicyContext
): Promise<PolicyDecision> {
  const cfg = getApprovalsConfig()

  // 1. YOLO — frozen at import time.
  if (YOLO_FROZEN || cfg.yoloMode) {
    return { verdict: 'allow' }
  }

  // 2. Toolset gate.
  if (ctx.activeToolsets.size > 0 && !ctx.activeToolsets.has(tool.toolset)) {
    return {
      verdict: 'deny',
      reason: `Toolset "${tool.toolset}" is not enabled for this session.`
    }
  }

  // 3. Per-tool confirmOverride.
  const override = cfg.toolsets.confirmOverride[tool.name]
  if (override === 'always') return { verdict: 'allow' }
  if (override === 'never') {
    return { verdict: 'deny', reason: `Tool "${tool.name}" is disabled by user override.` }
  }

  // 4. Layer A — dangerous commands (terminal toolset).
  if (tool.toolset === 'terminal') {
    const cmd = extractCommand(input)
    if (cmd) {
      const danger = isDangerous(cmd, false)
      if (danger.match) {
        return {
          verdict: 'confirm',
          reason: {
            rule: 'dangerous-command',
            message: `Command matches dangerous pattern: ${danger.pattern} — ${danger.reason}`,
            detail: { pattern: danger.pattern, reason: danger.reason, command: cmd }
          }
        }
      }
      // Smart approve: ask the aux LLM if the command is borderline.
      // Conservative — when smartApprove is off, fall through to builtin default.
      if (cfg.smartApprove) {
        const approved = await smartApprove(cmd, ctx.cwd ?? '')
        if (!approved) {
          return {
            verdict: 'confirm',
            reason: {
              rule: 'smart-approve-deny',
              message: 'Auxiliary LLM flagged this command as potentially unsafe.',
              detail: { command: cmd }
            }
          }
        }
      }
    }
  }

  // 5. Layer B — write-path denylist (file + skills writes).
  const writePath = extractWritePath(tool.name, input)
  if (writePath) {
    const resolved = resolveAgentPath(writePath, ctx.cwd)
    const denied = isWriteDenied(resolved)
    if (denied) {
      return {
        verdict: 'deny',
        reason: `Refused: ${writePath} matches denylist (${denied})`
      }
    }
  }

  // 6. Builtin default.
  if (tool.needsConfirmation) {
    return {
      verdict: 'confirm',
      reason: {
        rule: 'default-confirm',
        message: `Tool "${tool.name}" requires confirmation by default.`
      }
    }
  }

  return { verdict: 'allow' }
}

/** Pulls the command string out of a terminal tool's input. */
function extractCommand(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  const cmd = obj['command'] ?? obj['cmd']
  return typeof cmd === 'string' ? cmd : null
}

/**
 * Pulls a write-path out of a tool's input. Currently covers the write_file /
 * patch_file / skill_manage create|update|delete shape — schema extensions
 * land when those tools land in Phase 5. Unknown shape returns null.
 */
function extractWritePath(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null
  const obj = input as Record<string, unknown>
  switch (toolName) {
    case 'write_file':
    case 'patch_file': {
      const p = obj['path']
      return typeof p === 'string' ? p : null
    }
    case 'skill_manage': {
      // We pass a synthetic "name" or "category/name" — denylist is anchored on
      // ~/.ai-agent-studio/skills/, which is *not* in the denylist, so this
      // mostly returns null. Kept for symmetry with future write tools.
      return null
    }
    default:
      return null
  }
}
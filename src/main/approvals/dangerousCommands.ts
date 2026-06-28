/**
 * Layer A — dangerous-command detection for terminal tools.
 *
 * Adapted from Hermes's DANGEROUS_PATTERNS. We intentionally keep this list
 * conservative and human-readable. The full Hermes set lives in
 * `tools/approval.py`; this is the subset that matters for an interactive
 * desktop agent. Order matters — the first match wins.
 */

export interface DangerousMatch {
  pattern: string
  reason: string
  regex: RegExp
}

/**
 * Each entry: { readable name, human reason, regex }.
 * Regexes are case-insensitive (built with the `i` flag) and operate on
 * the raw command line; multiline and shell-globbing aware.
 */
export const DANGEROUS_PATTERNS: DangerousMatch[] = [
  {
    pattern: 'rm -rf /',
    reason: 'Recursive delete of root filesystem',
    regex: /\brm\s+(-\w*r\w*f\w*\s+(--?\w+\s+)*)?\/\s*(?:$|;|\||&)/i
  },
  {
    pattern: 'rm -rf ~',
    reason: 'Recursive delete of home directory',
    regex: /\brm\s+(-\w*r\w*f\w*\s+(--?\w+\s+)*)~\s*(?:$|;|\||&)/i
  },
  {
    pattern: 'rm -rf $HOME',
    reason: 'Recursive delete of $HOME',
    regex: /\brm\s+(-\w*r\w*f\w*\s+(--?\w+\s+)*)(\$HOME|\$\{HOME\})\s*(?:$|;|\||&)/i
  },
  {
    pattern: 'mkfs',
    reason: 'Filesystem format (destructive)',
    regex: /\bmkfs(\.\w+)?\s+/i
  },
  {
    pattern: 'dd to device',
    reason: 'dd writing to a block device',
    regex: /\bdd\s+[^|;&]*\bof\s*=\s*\/dev\//i
  },
  {
    pattern: 'chmod -R 777 /',
    reason: 'World-writable recursive chmod on root',
    regex: /\bchmod\s+(-\w*R\w*\s+)*777\s+\//i
  },
  {
    pattern: ':(){:|:&};:',
    reason: 'Fork bomb',
    regex: /:\s*\(\s*\)\s*\{s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i
  },
  {
    pattern: 'curl | sh',
    reason: 'Piping remote script directly to shell',
    regex: /\bcurl\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/i
  },
  {
    pattern: 'wget | sh',
    reason: 'Piping remote script directly to shell',
    regex: /\bwget\b[^|;&]*\|\s*(sudo\s+)?(ba)?sh\b/i
  },
  {
    pattern: 'shutdown / reboot',
    reason: 'System shutdown or reboot',
    regex: /\b(shutdown|reboot|poweroff|halt)\b/i
  },
  {
    pattern: 'systemctl disable',
    reason: 'Disabling a system service',
    regex: /\bsystemctl\s+(disable|mask|stop)\s+/i
  }
]

export interface DangerousResult {
  match: boolean
  pattern?: string
  reason?: string
}

/**
 * Returns the first matching dangerous pattern, or { match: false }.
 * If YOLO mode is on, returns { match: false } unconditionally — the
 * caller (policy.evaluatePolicy) is expected to short-circuit before this
 * function is reached in that case, but we double-guard here.
 */
export function isDangerous(command: string, yolo: boolean): DangerousResult {
  if (yolo) return { match: false }
  for (const p of DANGEROUS_PATTERNS) {
    if (p.regex.test(command)) {
      return { match: true, pattern: p.pattern, reason: p.reason }
    }
  }
  return { match: false }
}

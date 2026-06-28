import { homedir } from 'os'
import { isAbsolute, resolve, sep, normalize } from 'path'

/**
 * Layer B — write-path denylist for file / terminal tools.
 *
 * Hard-coded denylist matches Hermes's `tools/approval.py` set, plus the
 * `~/.ai-agent-studio/config/approvals.yaml` file (the LLM must not be able
 * to read its own approval config). Mirrors `~/.netrc`, `~/.ssh/*`,
 * `~/.aws`, `~/.gnupg`, etc.
 *
 * WORKSPACE_SAFE_ROOT (pathsep-separated) overrides to an allowlist.
 */

const HOME = homedir()

/** Suffix paths — relative to HOME. Matched exactly. */
const DENY_SUFFIXES = [
  '.ssh/authorized_keys',
  '.ssh/id_rsa',
  '.ssh/id_ed25519',
  '.ssh/id_ecdsa',
  '.ssh/id_dsa',
  '.ssh/config',
  '.ssh/known_hosts',
  '.netrc',
  '.pgpass',
  '.npmrc',
  '.pypirc',
  '.git-credentials'
]

/** Prefix paths — any path under these is denied. */
const DENY_PREFIXES = [
  `${HOME}/.ssh`,
  `${HOME}/.aws`,
  `${HOME}/.gnupg`,
  `${HOME}/.kube`,
  `${HOME}/.docker`,
  `${HOME}/.config/gh`,
  `${HOME}/.config/gcloud`,
  `${HOME}/.ai-agent-studio/config/approvals.yaml`
]

/** System-level prefixes (POSIX only). */
const SYSTEM_PREFIXES = ['/etc/sudoers.d', '/etc/systemd']

/** Resolved allowlist (overrides everything when set). */
function safeRoots(): string[] {
  const raw = process.env['WORKSPACE_SAFE_ROOT']
  if (!raw) return []
  return raw
    .split(sep)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => (isAbsolute(p) ? normalize(p) : normalize(resolve(p))))
}

/** Resolve a user-supplied path against the active cwd, normalising the result. */
export function resolveAgentPath(p: string, cwd?: string): string {
  if (!p) return p
  if (isAbsolute(p)) return normalize(p)
  const base = cwd && cwd.length > 0 ? cwd : process.cwd()
  return normalize(resolve(base, p))
}

/**
 * Returns a human reason if the path is denied, or null if it's allowed.
 * If WORKSPACE_SAFE_ROOT is set and matches, the path is allowed.
 */
export function isWriteDenied(absPath: string): string | null {
  if (!absPath) return null
  const allowed = safeRoots()
  if (allowed.length > 0) {
    if (allowed.some((root) => absPath === root || absPath.startsWith(root + sep))) {
      return null
    }
    return `WORKSPACE_SAFE_ROOT is set; "${absPath}" is not under any allowed root`
  }

  // Suffix denylist
  for (const suf of DENY_SUFFIXES) {
    const full = `${HOME}/${suf}`
    if (absPath === full) return `path matches denylist suffix ~/.${suf}`
  }

  // Prefix denylist
  for (const pre of DENY_PREFIXES) {
    if (absPath === pre || absPath.startsWith(pre + sep)) {
      return `path matches denylist prefix ${pre}`
    }
  }

  // System prefixes (POSIX only)
  if (process.platform !== 'win32') {
    for (const pre of SYSTEM_PREFIXES) {
      if (absPath === pre || absPath.startsWith(pre + sep)) {
        return `path matches system denylist prefix ${pre}`
      }
    }
  }

  return null
}

/** Read-side equivalent — used by read_file. Currently a superset of write denylist. */
export function isReadDenied(absPath: string): string | null {
  return isWriteDenied(absPath)
}
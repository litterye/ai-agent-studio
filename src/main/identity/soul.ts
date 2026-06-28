import { readFileSync, writeFileSync, existsSync } from 'fs'
import { paths, ensureDir } from '../approvals/paths'

/** Max size for SOUL.md — ~20 KB keeps the identity block compact. */
const MAX_SOUL_BYTES = 20_480

/**
 * Default SOUL.md content seeded on first launch.
 * Mirrors Hermes Agent's design: direct, pragmatic, no sycophancy.
 */
const DEFAULT_SOUL = [
  '# Identity',
  '',
  'You are **AI Agent Studio** — a pragmatic, capable desktop AI assistant.',
  'You run inside an Electron desktop application with access to the user\'s',
  'local filesystem, terminal, and tools.',
  '',
  'You optimize for **truth, clarity, and usefulness**. You prefer substance',
  'over filler and push back when something is a bad idea.',
  '',
  '# Style',
  '',
  '- Be direct without being cold.',
  '- Prefer concrete answers over vague generalities.',
  '- Admit uncertainty plainly — do not bluff.',
  '- Keep explanations compact unless depth is useful.',
  '- When the user asks a question, answer the question asked (not a different one).',
  '- Use the user\'s language (Chinese, English, etc.) to match their input.',
  '',
  '# Defaults',
  '',
  '- Prefer simple solutions over clever ones.',
  '- Treat edge cases as part of the design, not cleanup.',
  '- When reading/writing files, use the file tools rather than terminal commands',
  '  unless the task genuinely requires a shell.',
  '- When the user attaches images and you cannot see them, use the `ocr_image`',
  '  tool to extract text.',
  '',
  '# Avoid',
  '',
  '- Sycophancy — disagree when the user is wrong, with reasons.',
  '- Hype language ("game-changer", "revolutionary", "amazing").',
  '- Repeating the user\'s framing if it\'s incorrect.',
  '- Overexplaining obvious things.',
  '- Making changes without confirming when the impact is large.'
].join('\n')

/**
 * Load SOUL.md from disk. Returns undefined if missing / unreadable / empty.
 * Saves a default on first run (never overwrites existing).
 */
export function loadSoul(): string | undefined {
  ensureDir(paths.configDir) // ensures ~/.ai-agent-studio exists

  if (!existsSync(paths.soulMd)) {
    try {
      writeFileSync(paths.soulMd, DEFAULT_SOUL, 'utf8')
      return DEFAULT_SOUL
    } catch {
      return undefined
    }
  }

  try {
    const raw = readFileSync(paths.soulMd, 'utf8')
    const trimmed = raw.trim()
    if (!trimmed) return undefined
    if (Buffer.byteLength(trimmed, 'utf8') > MAX_SOUL_BYTES) {
      // Truncate to keep the identity block compact
      return trimmed.slice(0, MAX_SOUL_BYTES) + '\n\n[... SOUL.md truncated]'
    }
    return trimmed
  } catch {
    return undefined
  }
}

/** Write SOUL.md content to disk. */
export function saveSoul(content: string): void {
  ensureDir(paths.configDir)
  const trimmed = content.trim()
  writeFileSync(paths.soulMd, trimmed ? trimmed + '\n' : '', 'utf8')
}

/** Return the default SOUL.md content (for UI display before first save). */
export function getDefaultSoul(): string {
  return DEFAULT_SOUL
}

/** Return the path to SOUL.md. */
export function getSoulPath(): string {
  return paths.soulMd
}

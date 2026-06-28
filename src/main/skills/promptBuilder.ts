import { scanSkills, type SkillRecord } from './scanner'
import { readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { paths } from '../approvals/paths'

/**
 * Builds the <available_skills>...</available_skills> block injected into
 * the system prompt. The LLM is told: "When a skill matches the user's
 * request, call skill_view(name) to load the full body."
 *
 * Cache strategy (v1):
 *  - In-process Map<name, SkillRecord>
 *  - Disk snapshot at ~/.ai-agent-studio/skills/.skills_prompt_snapshot.json
 *    with a per-file mtime+size manifest, used to skip re-parsing unchanged
 *    files. The snapshot is the source of truth across restarts.
 *  - The watcher in watcher.ts invalidates entries by mtime.
 *
 * We render the index lazily and cache the rendered string keyed by
 * (availableTools, availableToolsets, skills signature) to avoid rebuilding
 * the block on every agent turn.
 */

interface SnapshotEntry {
  absPath: string
  relativePath: string
  mtimeMs: number
  size: number
  record: SkillRecord
}

let _records: Map<string, SkillRecord> | null = null
let _renderCache: { key: string; text: string } | null = null

/** Force a full rescan. Called by the watcher on filesystem changes. */
export function invalidateSkillsCache(): void {
  _records = null
  _renderCache = null
}

/** Get all currently-known skills. Performs a scan on first call. */
export function getSkills(): SkillRecord[] {
  if (_records) return Array.from(_records.values())
  return loadFromSnapshot()
}

function loadFromSnapshot(): SkillRecord[] {
  // Fresh scan (no snapshot yet, or invalidated). Cheap enough.
  const fresh = scanSkills()
  const map = new Map<string, SkillRecord>()
  for (const r of fresh) map.set(r.relativePath, r)
  _records = map
  writeSnapshot(fresh)
  return fresh
}

function writeSnapshot(records: SkillRecord[]): void {
  try {
    const entries: SnapshotEntry[] = records.map((r) => ({
      absPath: r.absPath,
      relativePath: r.relativePath,
      mtimeMs: Number(r.mtimeNs / 1_000_000n),
      size: r.size,
      record: r
    }))
    writeFileSync(paths.skillsSnapshot, JSON.stringify(entries, (_k, v) => typeof v === 'bigint' ? Number(v) : v), 'utf8')
  } catch (err) {
    // Non-fatal: snapshot is an optimization.
    console.error('[skills] snapshot write failed', err)
  }
}

/** Read the existing snapshot from disk (used on app start). */
export function loadSnapshot(): void {
  if (!existsSync(paths.skillsSnapshot)) {
    _records = null
    return
  }
  try {
    const raw = readFileSync(paths.skillsSnapshot, 'utf8')
    const entries = JSON.parse(raw) as SnapshotEntry[]
    // Validate the snapshot by comparing each file's mtime+size to disk.
    // Mismatches are dropped — the watcher will catch new changes too.
    const map = new Map<string, SkillRecord>()
    for (const e of entries) {
      try {
        const stat = statSync(e.absPath)
        if (stat.mtimeMs === e.mtimeMs && stat.size === e.size) {
          map.set(e.relativePath, e.record)
        }
      } catch {
        // File gone — skip
      }
    }
    _records = map
  } catch (err) {
    console.error('[skills] snapshot read failed', err)
    _records = null
  }
}

/**
 * Build the <available_skills> block.
 * - `availableTools` / `availableToolsets` are the active set for this
 *   session; skills with `requires_tools` / `requires_toolsets` not in
 *   the set are filtered out.
 * - Skills with `fallback_for_tools` matching a missing tool are *kept*
 *   (they're the workaround for the missing tool).
 */
export function buildSkillsIndex(
  availableTools: Set<string> = new Set(),
  availableToolsets: Set<string> = new Set()
): string {
  const skills = getSkills()
  const key = `${skillsSignature(skills)}|${[...availableTools].sort().join(',')}|${[...availableToolsets].sort().join(',')}`
  if (_renderCache && _renderCache.key === key) return _renderCache.text

  const visible = skills.filter((s) => skillVisible(s, availableTools, availableToolsets))
  const text = renderIndex(visible)
  _renderCache = { key, text }
  return text
}

function skillVisible(
  s: SkillRecord,
  tools: Set<string>,
  toolsets: Set<string>
): boolean {
  const m = s.frontmatter.metadata?.hermes
  if (!m) return true
  // requires_tools: all must be present
  if (m.requires_tools && !m.requires_tools.every((t) => tools.has(t))) return false
  // requires_toolsets: all must be present
  if (m.requires_toolsets && !m.requires_toolsets.every((t) => toolsets.has(t))) return false
  return true
}

function skillsSignature(skills: SkillRecord[]): string {
  // Cheap signature: count + sorted relative paths. If any path's mtime
  // changes, the watcher invalidates the cache so this is just a hash hint.
  return `${skills.length}:${skills.map((s) => s.relativePath).sort().join(',')}`
}

function renderIndex(skills: SkillRecord[]): string {
  if (skills.length === 0) {
    return [
      '<available_skills>',
      '  (none — the user has not installed any skills yet)',
      '</available_skills>'
    ].join('\n')
  }
  const byCategory = new Map<string, SkillRecord[]>()
  for (const s of skills) {
    const list = byCategory.get(s.category) ?? []
    list.push(s)
    byCategory.set(s.category, list)
  }
  const lines: string[] = ['<available_skills>']
  const sortedCats = [...byCategory.keys()].sort()
  for (const cat of sortedCats) {
    lines.push(`  ${cat}:`)
    for (const s of byCategory.get(cat)!.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`    - ${s.relativePath}: ${s.frontmatter.description}`)
    }
  }
  lines.push('</available_skills>')
  lines.push('')
  lines.push(
    'When a skill matches the user request, call skill_view(name="<relativePath>") to load its full body. Do not invent or assume skill contents — always load them.'
  )
  return lines.join('\n')
}

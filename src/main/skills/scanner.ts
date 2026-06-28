import { readdirSync, statSync, readFileSync, existsSync } from 'fs'
import { join, relative, sep } from 'path'
import { paths, ensureDir } from '../approvals/paths'
import { parseSkill, skillMatchesPlatform, type ParsedSkill, type SkillFrontmatter } from './frontmatter'

/**
 * A skill as it lives on disk: relative category + name, parsed frontmatter,
 * body markdown, and a stable absolute path.
 */
export interface SkillRecord {
  /** Display name (also `frontmatter.name`). Unique. */
  name: string
  /** Category from the parent folder, used to group in the index. */
  category: string
  /** Absolute path to SKILL.md. */
  absPath: string
  /** Path relative to the skills dir, e.g. "coding/code-review". */
  relativePath: string
  frontmatter: SkillFrontmatter
  body: string
  /** mtime in ns (from fs.statSync) — used by the snapshot cache. */
  mtimeNs: bigint
  /** File size in bytes. */
  size: number
}

const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build'])

/** Ensure the skills directory exists, creating it on first run. */
export function ensureSkillsDir(): void {
  ensureDir(paths.skillsDir)
}

/**
 * Recursively scan the skills directory. Each SKILL.md found becomes a
 * SkillRecord. Invalid frontmatter is logged and skipped (the user can fix
 * the file and a watcher event will re-scan).
 */
export function scanSkills(): SkillRecord[] {
  ensureSkillsDir()
  const out: SkillRecord[] = []
  walk(paths.skillsDir, [], out)
  return out
}

function walk(dir: string, parents: string[], out: SkillRecord[]): void {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (EXCLUDED_DIRS.has(entry)) continue
    const abs = join(dir, entry)
    let stat
    try {
      stat = statSync(abs)
    } catch {
      continue
    }
    if (stat.isDirectory()) {
      walk(abs, [...parents, entry], out)
    } else if (stat.isFile() && entry === 'SKILL.md') {
      const record = tryParse(abs, parents)
      if (record) out.push(record)
    }
  }
}

function tryParse(abs: string, parents: string[]): SkillRecord | null {
  try {
    const raw = readFileSync(abs, 'utf8')
    const parsed = parseSkill(raw)
    if (!skillMatchesPlatform(parsed.frontmatter)) return null
    const stat = statSync(abs)
    const mtimeNs = BigInt(Math.floor(stat.mtimeMs)) * 1_000_000n
    const category = parents[0] ?? 'uncategorized'
    const relativePath = [...parents, parsed.frontmatter.name].join(sep)
    return {
      name: parsed.frontmatter.name,
      category,
      absPath: abs,
      relativePath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
      mtimeNs,
      size: stat.size
    }
  } catch (err) {
    console.error('[skills] skipping', abs, err)
    return null
  }
}

/** Read a single SKILL.md by relative path (e.g. "coding/code-review"). */
export function readSkill(relativePath: string): ParsedSkill | null {
  const abs = join(paths.skillsDir, relativePath, 'SKILL.md')
  if (!existsSync(abs)) return null
  const raw = readFileSync(abs, 'utf8')
  return parseSkill(raw)
}

export { relative, join }

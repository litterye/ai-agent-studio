import { readdirSync, statSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs'
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

/** Built-in skills seeded on first launch. These live in the user's skills dir
 *  so they can be customised, but are re-created if deleted. */
const BUILTIN_SKILLS: { dir: string; body: string }[] = [
  {
    dir: join('general', 'plan'),
    body: [
      '---',
      'name: plan',
      'description: 交互式规划模式。通过多轮讨论细化需求，生成 plan.md，创建 todo 并监督执行。',
      '---',
      '',
      '# Plan Mode',
      '',
      'You are entering a structured planning workflow. Follow the phases below',
      '**in order**. Do not skip ahead — each phase must complete before the next.',
      '',
      '## Trigger',
      'The user typed `/plan <goal>` to activate you. Extract the goal from their',
      'message (remove the `/plan` prefix) and begin.',
      '',
      '## Phase 1 — Understand the Goal',
      '',
      '1. Extract the goal description from the user\'s message.',
      '2. If the description is less than ~10 characters or is too vague, ask the',
      '   user for more detail before proceeding.',
      '3. Restate the goal in your own words and ask the user to confirm your',
      '   understanding is correct. **Do not proceed until the user confirms.**',
      '',
      '## Phase 2 — Multi-Round Detail Discussion',
      '',
      'Discuss the following areas **one at a time**. Ask one area, wait for the',
      'user\'s reply, then move to the next. Never batch multiple areas in one',
      'message.',
      '',
      '**Required areas (in order):**',
      '',
      '1. **Scope & Features** — What is in v1? What is explicitly out of scope?',
      '   List candidate features and ask the user to pick the v1 set.',
      '',
      '2. **Tech Stack** — For each major choice (language, framework, libraries,',
      '   storage), present 2–4 numbered options with brief pros/cons. Include an',
      '   "(other — describe)" option. Example:',
      '   ```',
      '   1. React + Vite — fast dev, huge ecosystem',
      '   2. Vue 3 + Vite — gentle learning, good DX',
      '   3. Vanilla HTML/JS — zero deps, simpler but less scalable',
      '   4. 其他（请描述）',
      '   ```',
      '',
      '3. **Architecture & Structure** — Project layout, key components/modules,',
      '   data flow. Ask the user to validate or adjust.',
      '',
      '4. **Constraints** — Performance targets, compatibility requirements,',
      '   deadlines, security considerations, anything that limits choices.',
      '',
      '**Interaction rules during Phase 2:**',
      '- Present numbered options for all consequential decisions.',
      '- Wait for the user to reply before moving on.',
      '- If the user changes their mind on a previous decision, go back and',
      '  re-confirm that area.',
      '- Do NOT make assumptions — when in doubt, ask.',
      '- Keep options concise: 2–4 choices max per question.',
      '',
      '## Phase 3 — Generate plan.md',
      '',
      'Once all four areas are confirmed, generate the plan file:',
      '',
      '1. Synthesise all confirmed decisions into a structured document.',
      '2. Use the `writeFile` tool to write `plan.md` in the workspace root.',
      '   The document must include these sections:',
      '',
      '   ```markdown',
      '   # Plan: <goal>',
      '',
      '   ## Goal',
      '   <one-paragraph summary>',
      '',
      '   ## Scope (v1)',
      '   - <feature 1>',
      '   - <feature 2>',
      '',
      '   ## Out of Scope (v1)',
      '   - <excluded feature>',
      '',
      '   ## Tech Stack',
      '   | Layer | Choice | Reason |',
      '   |-------|--------|--------|',
      '   | ...   | ...    | ...    |',
      '',
      '   ## Architecture',
      '   <project structure, component tree, data flow>',
      '',
      '   ## Implementation Steps',
      '   1. <step 1>',
      '   2. <step 2>',
      '   ...',
      '',
      '   ## Constraints',
      '   - <constraint>',
      '   ```',
      '',
      '3. After writing, tell the user where the file was saved and ask:',
      '   "plan.md 已生成。是否开始执行？"',
      '',
      '## Phase 4 — Execute via Todo',
      '',
      'Only when the user explicitly confirms ("开始", "yes", "执行", etc.):',
      '',
      '1. Read `plan.md` to refresh the implementation steps.',
      '2. Use the `todo` tool to create one task per implementation step:',
      '   `todo(action="add", content="<step>", activeForm="<present-tense label>")`',
      '3. Work through tasks **one at a time**. After completing each:',
      '   `todo(action="update", id=<n>, status="completed")`',
      '4. If blocked, pause and tell the user what you need.',
      '5. When all tasks are done, report the final result.',
      '',
      '## Rules',
      '',
      '- **Never skip phases.**',
      '- **Never ask about multiple areas in one message.**',
      '- **Always present options as numbered lists for key decisions.**',
      '- **Always confirm before writing files or executing.**',
      '- Use the user\'s language (Chinese / English) to match their input.',
      '- If the user says "skip" or "你自己定" for an area, make a sensible',
      '  default choice, document it, and move on.'
    ].join('\n')
  }
]

/** Ensure the skills directory exists, creating it on first run.
 *  Also seeds built-in skills that don't yet exist on disk. */
export function ensureSkillsDir(): void {
  ensureDir(paths.skillsDir)
  seedBuiltinSkills()
}

/** Write any BUILTIN_SKILLS that are not already on disk. */
function seedBuiltinSkills(): void {
  for (const skill of BUILTIN_SKILLS) {
    const dir = join(paths.skillsDir, skill.dir)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) {
      try {
        mkdirSync(dir, { recursive: true })
        writeFileSync(file, skill.body, 'utf8')
      } catch (err) {
        console.error('[skills] failed to seed', skill.dir, err)
      }
    }
  }
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
    const category = parents[0] ?? 'general'
    const relativePath = parents.length > 0 ? parents.join(sep) : parsed.frontmatter.name
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

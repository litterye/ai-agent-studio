import { writeFileSync, rmSync, existsSync } from 'fs'
import { join, dirname, sep } from 'path'
import { z } from 'zod'
import { paths, ensureDir } from '../approvals/paths'
import { readSkill, scanSkills } from './scanner'
import { parseSkill } from './frontmatter'
import { invalidateSkillsCache } from './promptBuilder'
import type { AgentTool } from '../tools/types'

/**
 * skill_view: load a skill's full body. The LLM is told in the system prompt
 * to call this when a skill matches the user's request. Needs no confirmation.
 */
export function createSkillViewTool(): AgentTool {
  return {
    name: 'skill_view',
    toolset: 'skills',
    source: 'builtin',
    needsConfirmation: false,
    description:
      'Load the full body of a skill by its relative path (e.g. "coding/code-review"). ' +
      'Returns the SKILL.md frontmatter and markdown body. Use this whenever a skill ' +
      'listed in <available_skills> matches the user request.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Relative skill path, exactly as shown in <available_skills> (e.g. "coding/code-review").'
        }
      },
      required: ['name'],
      additionalProperties: false
    },
    run: async (input) => {
      const parsed = z.object({ name: z.string().min(1) }).parse(input)
      const skill = readSkill(parsed.name)
      if (!skill) {
        return `Skill not found: ${parsed.name}. Use skill_manage(action="list") to see available skills.`
      }
      return [
        `# ${skill.frontmatter.name}`,
        '',
        `> ${skill.frontmatter.description}`,
        '',
        skill.body
      ].join('\n')
    }
  }
}

const ManageSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list')
  }),
  z.object({
    action: z.literal('create'),
    category: z.string().min(1),
    name: z.string().min(1),
    body: z.string().min(1)
  }),
  z.object({
    action: z.literal('update'),
    name: z.string().min(1),
    body: z.string().min(1)
  }),
  z.object({
    action: z.literal('delete'),
    name: z.string().min(1)
  })
])

/**
 * skill_manage: create / update / delete a skill. Writes to disk; gated by
 * the skills write-approval policy in tools/policy.ts (Phase 4 will wire
 * the policy hook; for now the tool always confirms via needsConfirmation).
 */
export function createSkillManageTool(): AgentTool {
  return {
    name: 'skill_manage',
    toolset: 'skills',
    source: 'builtin',
    needsConfirmation: true,
    description:
      'Manage installed skills. Actions: list (returns all skills), ' +
      'create (writes a new skill with category/name/body), update (overwrites ' +
      'an existing skill by name), delete (removes a skill by name). The "name" ' +
      'argument for update/delete is the relative path (e.g. "coding/code-review").',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'create', 'update', 'delete'] },
        category: { type: 'string', description: 'Category folder for create. Ignored otherwise.' },
        name: { type: 'string', description: 'Skill name (for create) or relative path (for update/delete).' },
        body: { type: 'string', description: 'SKILL.md content (raw markdown, including frontmatter).' }
      },
      required: ['action'],
      additionalProperties: false
    },
    run: async (input) => {
      const req = ManageSchema.parse(input)
      switch (req.action) {
        case 'list': {
          const skills = scanSkills()
          if (skills.length === 0) return 'No skills installed.'
          return skills
            .map((s) => `${s.relativePath}: ${s.frontmatter.description}`)
            .join('\n')
        }
        case 'create':
          return writeSkill(req.category, req.name, req.body)
        case 'update':
          return updateSkill(req.name, req.body)
        case 'delete':
          return deleteSkill(req.name)
      }
    }
  }
}

function writeSkill(category: string, _name: string, body: string): string {
  // Validate the body parses as a skill before writing
  const parsed = parseSkill(body)
  const dir = join(paths.skillsDir, category, parsed.frontmatter.name)
  if (!isSafeRelativePath(dir, paths.skillsDir)) {
    return `Refused: path "${dir}" is outside the skills directory.`
  }
  if (existsSync(join(dir, 'SKILL.md'))) {
    return `Refused: skill already exists at ${dir}. Use action="update" instead.`
  }
  ensureDir(dir)
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8')
  invalidateSkillsCache()
  return `Skill created at ${join(category, parsed.frontmatter.name)}`
}

function updateSkill(relativePath: string, body: string): string {
  const parsed = parseSkill(body)
  const abs = join(paths.skillsDir, relativePath, 'SKILL.md')
  if (!isSafeRelativePath(join(paths.skillsDir, relativePath), paths.skillsDir)) {
    return `Refused: path "${relativePath}" is outside the skills directory.`
  }
  if (!existsSync(abs)) return `Refused: skill not found at ${relativePath}.`
  // If the user renamed the skill inside the body, also rename the folder.
  const expected = join(paths.skillsDir, dirname(relativePath).split(sep).pop() ?? '_', parsed.frontmatter.name)
  if (abs !== join(expected, 'SKILL.md')) {
    ensureDir(expected)
    writeFileSync(join(expected, 'SKILL.md'), body, 'utf8')
    rmSync(join(paths.skillsDir, relativePath, 'SKILL.md'), { force: true })
    try {
      rmSync(join(paths.skillsDir, relativePath), { recursive: true, force: true })
    } catch {
      // Folder had other files; leave them.
    }
  } else {
    writeFileSync(abs, body, 'utf8')
  }
  invalidateSkillsCache()
  return `Skill updated at ${relativePath}`
}

function deleteSkill(relativePath: string): string {
  const abs = join(paths.skillsDir, relativePath)
  if (!isSafeRelativePath(abs, paths.skillsDir)) {
    return `Refused: path "${relativePath}" is outside the skills directory.`
  }
  if (!existsSync(abs)) return `Refused: skill not found at ${relativePath}.`
  rmSync(abs, { recursive: true, force: true })
  invalidateSkillsCache()
  return `Skill deleted at ${relativePath}`
}

/** True if `child` resolves to a path inside `parent` (no ../ escape). */
function isSafeRelativePath(child: string, parent: string): boolean {
  const rel = child.startsWith(parent) ? child.slice(parent.length) : ''
  if (rel.startsWith(sep) || rel.startsWith('/') || rel.startsWith('\\')) {
    // Strip the leading separator and re-check for parent traversal.
    const trimmed = rel.replace(/^[\\/]+/, '')
    return !trimmed.split(/[\\/]+/).includes('..') && trimmed.length > 0
  }
  return !rel.split(/[\\/]+/).includes('..') && rel.length > 0
}

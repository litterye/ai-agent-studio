import matter from 'gray-matter'
import { z } from 'zod'

/**
 * Frontmatter shape for SKILL.md. Only `name` and `description` are required —
 * everything else is metadata that the prompt builder uses for filtering.
 *
 * Adapted from Hermes's `agent/skill_utils.py:parse_frontmatter`.
 */
export const SkillFrontmatterSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1).max(500),
  version: z.string().optional(),
  platforms: z.array(z.enum(['linux', 'macos', 'windows'])).optional(),
  metadata: z
    .object({
      hermes: z
        .object({
          tags: z.array(z.string()).optional(),
          related_skills: z.array(z.string()).optional(),
          fallback_for_toolsets: z.array(z.string()).optional(),
          requires_toolsets: z.array(z.string()).optional(),
          fallback_for_tools: z.array(z.string()).optional(),
          requires_tools: z.array(z.string()).optional()
        })
        .optional()
    })
    .optional()
})

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

export interface ParsedSkill {
  frontmatter: SkillFrontmatter
  body: string
}

const PLATFORM_MAP: Record<NodeJS.Platform, 'linux' | 'macos' | 'windows'> = {
  aix: 'linux',
  android: 'linux',
  cygwin: 'linux',
  darwin: 'macos',
  freebsd: 'linux',
  haiku: 'linux',
  linux: 'linux',
  netbsd: 'linux',
  openbsd: 'linux',
  sunos: 'linux',
  win32: 'windows'
}

/**
 * Parse raw SKILL.md content. Throws on invalid frontmatter (caller decides
 * whether to skip the skill or surface the error).
 */
export function parseSkill(raw: string): ParsedSkill {
  // Strip code-fence wrapping that some LLMs add around the markdown
  let cleaned = raw.trim()
  cleaned = cleaned.replace(/^```(?:markdown|md|yaml)?\s*\n/, '')
  cleaned = cleaned.replace(/\n```\s*$/, '')
  const parsed = matter(cleaned)
  const fm = SkillFrontmatterSchema.parse(parsed.data)
  return { frontmatter: fm, body: parsed.content.trim() }
}

/** True if the skill's `platforms` list (if any) includes the current OS. */
export function skillMatchesPlatform(fm: SkillFrontmatter): boolean {
  if (!fm.platforms || fm.platforms.length === 0) return true
  const current = PLATFORM_MAP[process.platform] ?? 'linux'
  return fm.platforms.includes(current)
}

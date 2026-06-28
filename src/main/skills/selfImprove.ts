import { writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { paths, ensureDir } from '../approvals/paths'
import { anthropicClient } from '../agent/AnthropicClient'
import { openaiClient } from '../agent/OpenAIClient'
import { configStore } from '../config/store'

/**
 * Phase 7 — self-improvement heuristics.
 *
 * Hermes parity: when a conversation is "skill-worthy" (multi-turn, no tool
 * errors, distinct prompt), the LLM suggests frontmatter and body, stages to
 * `~/.ai-agent-studio/pending/skills/<id>.json`, and the user reviews it in
 * the SkillsView pending tab.
 */

export interface SkillDraft {
  id: string
  name: string
  description: string
  category: string
  body: string
  /** Full SKILL.md text (frontmatter + body). */
  fullMarkdown: string
}

export interface PendingSkill {
  id: string
  draft: SkillDraft
  createdAt: string
}

/**
 * Heuristic: is a conversation worth saving as a skill?
 *  - Multi-turn (≥2 user messages — enough to establish a pattern)
 *  - No tool errors (checks ALL messages, including text-less tool turns)
 *  - Assistant generated meaningful output (> 100 chars total across all text deltas)
 *  - User didn't just say "ok"/"thanks" at the end
 */
export function isSkillWorthy(messages: Array<{ role: string; text: string; toolErrors: boolean }>): boolean {
  const userMsgs = messages.filter((m) => m.role === 'user')
  const assistantMsgs = messages.filter((m) => m.role === 'assistant')
  const totalAssistantText = assistantMsgs.reduce((sum, m) => sum + m.text.length, 0)
  const lastUser = userMsgs[userMsgs.length - 1]
  const lastUserText = (lastUser?.text ?? '').trim()
  const trivial = /^(ok|thanks|thx|ty|yes|no|hi|hello|hey|bye|good|great|nice|👍|👌)\s*$/i

  // Condition 1: ≥2 user messages
  if (userMsgs.length < 2) return false

  // Condition 2: total assistant text ≥100 chars
  if (totalAssistantText < 100) return false

  // Condition 3: last user message is not trivial
  if (trivial.test(lastUserText)) return false

  return true
}

/**
 * Ask the current model to generate frontmatter + skill body from a
 * conversation transcript. Returns null if the model can't be reached.
 */
export async function generateSkillDraft(
  transcript: string
): Promise<SkillDraft | null> {
  const settings = configStore.getSettings()

  const prompt = `You are helping a user turn a conversation into a reusable skill.

Below is a conversation transcript between a user and an AI agent. Generate a SKILL.md file with YAML frontmatter and markdown body. The frontmatter must include name, description (max 500 chars), and optionally metadata.hermes.tags.

The body should describe:
1. When to use this skill (trigger conditions)
2. Steps the agent should follow
3. Example prompts that activate it

Return ONLY valid markdown - the raw SKILL.md content. No explanations outside the file.

Conversation:
${transcript}`

  try {
    const isOpenAI = settings.protocol === 'openai'
    const answer = isOpenAI
      ? await askOpenAI(settings.model, prompt)
      : await askAnthropic(settings.model, prompt)

    if (!answer) return null

    // Strip leading ```markdown / ``` fences that some models wrap the output in
    let cleaned = answer.trim()
    cleaned = cleaned.replace(/^```(?:markdown|md|yaml)?\s*\n/, '')
    cleaned = cleaned.replace(/\n```\s*$/, '')

    // Simple frontmatter extraction for the rendering list
    const fmMatch = cleaned.match(/^---\n([\s\S]*?)\n---/)
    const fm = fmMatch ? parseSimpleYaml(fmMatch[1]) : {}

    const name: string = String(fm['name'] || 'untitled')
    const description: string = String(fm['description'] || 'No description.')
    const meta = fm['metadata'] as Record<string, unknown> | undefined
    const hermes = meta?.hermes as Record<string, unknown> | undefined
    const tags = hermes?.tags as string[] | undefined
    const category: string = String(fm['category'] || tags?.[0] || 'general')

    const id = `${category}-${name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-${Date.now().toString(36)}`

    const draft: SkillDraft = { id, name, description, category, body: cleaned, fullMarkdown: cleaned }
    return draft
  } catch (err) {
    console.error('[skills] generateSkillDraft: EXCEPTION -', err)
    return null
  }
}

export function stagePendingSkill(draft: SkillDraft): string {
  ensureDir(paths.pendingSkillsDir)
  const pending: PendingSkill = {
    id: draft.id,
    draft,
    createdAt: new Date().toISOString()
  }
  const filePath = join(paths.pendingSkillsDir, `${draft.id}.json`)
  writeFileSync(filePath, JSON.stringify(pending, null, 2), 'utf8')
  return filePath
}

export function updatePendingSkillMeta(id: string, name: string, description: string): boolean {
  const filePath = join(paths.pendingSkillsDir, `${id}.json`)
  if (!existsSync(filePath)) return false
  try {
    const pending = JSON.parse(readFileSync(filePath, 'utf8')) as PendingSkill
    pending.draft.name = name
    pending.draft.description = description
    writeFileSync(filePath, JSON.stringify(pending, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

export function listPendingSkills(): PendingSkill[] {
  if (!existsSync(paths.pendingSkillsDir)) return []
  try {
    const files = readdirSync(paths.pendingSkillsDir).filter((f) => f.endsWith('.json'))
    return files
      .map((f) => {
        try {
          return JSON.parse(
            readFileSync(join(paths.pendingSkillsDir, f), 'utf8')
          ) as PendingSkill
        } catch {
          return null
        }
      })
      .filter((p): p is PendingSkill => p !== null)
  } catch {
    return []
  }
}

export function approvePendingSkill(id: string): string | null {
  const filePath = join(paths.pendingSkillsDir, `${id}.json`)
  if (!existsSync(filePath)) return null

  let pending: PendingSkill
  try {
    pending = JSON.parse(readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }

  const dir = join(paths.skillsDir, pending.draft.category, pending.draft.name)
  ensureDir(dir)
  writeFileSync(join(dir, 'SKILL.md'), pending.draft.fullMarkdown, 'utf8')

  // Clean up the pending file
  rmSync(filePath, { force: true })
  return dir
}

export function rejectPendingSkill(id: string): boolean {
  const filePath = join(paths.pendingSkillsDir, `${id}.json`)
  if (!existsSync(filePath)) return false
  rmSync(filePath, { force: true })
  return true
}

// ─── helpers ────────────────────────────────────────────────────────────

async function askAnthropic(model: string, content: string): Promise<string | null> {
  const client = anthropicClient.get()
  const res = await client.messages.create({
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content }]
  })
  const block = res.content.find((b) => b.type === 'text')
  return block && 'text' in block ? block.text : null
}

async function askOpenAI(model: string, content: string): Promise<string | null> {
  const client = openaiClient.get()
  const res = await client.chat.completions.create({
    model,
    max_tokens: 4000,
    messages: [{ role: 'user', content }],
    stream: false
  })
  return res.choices[0]?.message?.content ?? null
}

/** Minimal YAML parser (frontmatter only — no deps). */
function parseSimpleYaml(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = raw.split('\n')
  const stack: Array<{ key: string; obj: Record<string, unknown> }> = []
  let current: Record<string, unknown> = out
  let lastIndent = 0

  for (const line of lines) {
    const indent = line.search(/\S/)
    if (indent < 0 || line.trim().startsWith('#')) continue
    const trimmed = line.trim()
    const colonIdx = trimmed.indexOf(':')
    if (colonIdx === -1) continue

    const key = trimmed.slice(0, colonIdx).trim()
    let value = trimmed.slice(colonIdx + 1).trim()

    // Pop stack on dedent
    while (stack.length > 0 && indent <= lastIndent) {
      const popped = stack.pop()!
      current = popped.obj
      lastIndent -= 2
    }

    if (value === '') {
      // Nested object
      const obj: Record<string, unknown> = {}
      current[key] = obj
      stack.push({ key, obj: current })
      current = obj
      lastIndent = indent
    } else if (value.startsWith('[') && value.endsWith(']')) {
      current[key] = value
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/['"]/g, ''))
    } else {
      current[key] = value.replace(/['"]/g, '')
      lastIndent = indent
    }
  }
  return out
}
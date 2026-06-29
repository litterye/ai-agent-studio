import type { AgentEvent, ChatMessage, AttachmentMeta } from '@shared/ipc'
import type { AgentTool } from '../../tools/types'
import { evaluatePolicy, type PolicyContext, type PolicyReason } from '../../tools/policy'
import { readFileSync } from 'fs'
import { extname } from 'path'

export interface AgentCallbacks {
  emit(event: AgentEvent): void
  /**
   * Ask the renderer to confirm a tool call. Resolves with the user's choice,
   * including the policy reason that triggered the dialog (so the renderer can
   * show "dangerous command: rm -rf /" rather than just "needs confirmation").
   * `sessionAlways` indicates the user picked "always this session" — the
   * caller should persist the override via setToolOverride.
   */
  confirm(
    toolName: string,
    input: unknown,
    reason: PolicyReason | null
  ): Promise<{ approved: boolean; sessionAlways?: boolean }>
  /** Returns true if the run has been cancelled. */
  isCancelled(): boolean
}

/** Optional system prompt + cwd context + model overrides for a run. */
export interface RunContext {
  /** System prompt (skills index + cwd context + role instructions). */
  system?: string
  /** Working directory the agent is operating in. */
  cwd?: string
  /** Active toolsets for the session — passed through to policy.evaluatePolicy. */
  activeToolsets?: Set<string>
  /** Per-session model override (from DB session row). */
  modelOverride?: string
  /** Per-session protocol override. */
  protocolOverride?: string
  /** Per-session effort override. */
  effortOverride?: string
  /** Per-session base URL override. */
  baseUrlOverride?: string
  /** Per-session vision mode override. 'auto' | 'native' | 'text'. Falls back to 'text'. */
  visionModeOverride?: string
  /** Per-session API key override (resolved from ModelStore). Falls back to global config. */
  apiKeyOverride?: string
  /** DB session ID — used for memory extraction tracing. */
  sessionId?: string
}

/** A provider-specific implementation of the agentic loop. */
export interface AgentRunner {
  run(
    runId: string,
    history: ChatMessage[],
    tools: AgentTool[],
    cb: AgentCallbacks,
    ctx?: RunContext
  ): Promise<void>
}

export interface ToolCallRequest {
  id: string
  name: string
  input: unknown
}

export interface ToolCallOutcome {
  id: string
  name: string
  isError: boolean
  content: string
}

/**
 * Shared tool dispatch: policy → confirmation gate → execution → result emit.
 * Used by both provider runners so the gating logic lives in one place.
 */
export async function executeToolCall(
  runId: string,
  call: ToolCallRequest,
  tools: AgentTool[],
  cb: AgentCallbacks,
  ctx?: RunContext
): Promise<ToolCallOutcome> {
  const tool = tools.find((t) => t.name === call.name)
  let isError = false
  let content: string

  if (!tool) {
    isError = true
    content = `Unknown tool: ${call.name}`
  } else {
    // 1. Policy gate — three-layer (dangerous, denylist, default).
    const policyCtx: PolicyContext = {
      activeToolsets: ctx?.activeToolsets ?? new Set<string>(),
      cwd: ctx?.cwd
    }
    const decision = await evaluatePolicy(tool, call.input, policyCtx)

    if (decision.verdict === 'deny') {
      isError = true
      content = `Tool call denied by policy: ${decision.reason}`
    } else {
      // 2. Confirmation gate — only fires on 'confirm'.
      let approved = true
      let sessionAlways = false
      if (decision.verdict === 'confirm') {
        const res = await cb.confirm(call.name, call.input, decision.reason)
        approved = res.approved
        sessionAlways = !!res.sessionAlways
      }

      if (!approved) {
        isError = true
        content = 'Tool call denied by user.'
      } else {
        try {
          content = await tool.run(call.input)
          if (tool.maxResultSizeChars && content.length > tool.maxResultSizeChars) {
            content =
              content.slice(0, tool.maxResultSizeChars) +
              `\n\n[... truncated, ${content.length - tool.maxResultSizeChars} more chars ...]`
          }
        } catch (err) {
          isError = true
          content = err instanceof Error ? err.message : String(err)
        }
      }

      // Notify renderer when the user picked "always this session" so it can
      // write a per-tool override. This is a separate event so the renderer
      // can react without re-running the policy.
      if (decision.verdict === 'confirm' && sessionAlways) {
        cb.emit({
          type: 'policy_decision',
          runId,
          toolName: call.name,
          decision: 'session-always'
        })
      }
    }
  }

  cb.emit({
    type: 'tool_result',
    runId,
    toolName: call.name,
    id: call.id,
    isError,
    content
  })
  return { id: call.id, name: call.name, isError, content }
}

export const MAX_TURNS = 100
export const MAX_TOKENS = 64000

/** Turn at which a wrap-up nudge is injected — the model is told to finish soon. */
export const WRAP_UP_TURN = 85

/**
 * Approximate character limit for the full message history.
 * ~160K chars ≈ 180K tokens (varies by model/tokenizer) — we trim at this
 * threshold to avoid context-window errors. Most modern models support
 * 200K tokens, so this is a conservative 80% ceiling.
 */
const MAX_CONTEXT_CHARS = 160_000

/**
 * Trim older messages from `messages` while preserving:
 *  - the first 2 user messages (context establishment)
 *  - the last 20 messages (recent context)
 *
 * Mutates the array in place. Safe to call every turn — only trims when needed.
 */
export function trimMessages(messages: Array<{ role: string; content: unknown }>): void {
  const totalChars = JSON.stringify(messages).length
  if (totalChars <= MAX_CONTEXT_CHARS) return

  // Keep first 2 user messages + last 20 messages
  const userIndices: number[] = []
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === 'user') userIndices.push(i)
  }

  const keepHead = userIndices.length >= 2 ? userIndices[1] + 1 : 0
  const keepTail = Math.max(20, messages.length - keepHead)

  const head = messages.slice(0, keepHead)
  const tail = messages.slice(-keepTail)

  messages.length = 0
  messages.push(...head, ...tail)
}

/**
 * Build a wrap-up prompt injected when approaching MAX_TURNS.
 * Tells the model to finish its current task and deliver results now.
 */
export function buildWrapUpPrompt(): string {
  return (
    '[System notice] You are approaching the conversation turn limit. ' +
    'Stop exploring and deliver your final answer now. ' +
    'If you have partial results, summarise them. ' +
    'If you were about to run more tools, explain what remains to be done ' +
    'so the user can continue in a follow-up message. ' +
    'Do NOT start any new tool calls — just write your conclusion.'
  )
}

// ─── Multimodal content builders ────────────────────────────────────────

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'])
const TEXT_EXTS = new Set([
  '.txt', '.md', '.json', '.xml', '.yaml', '.yml', '.toml', '.csv', '.ini', '.cfg',
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.vue', '.svelte', '.html', '.css', '.scss', '.less',
  '.sql', '.graphql', '.proto',
  '.log', '.env', '.gitignore', '.dockerignore',
])
const MAX_TEXT_FILE_BYTES = 1_024_000 // 1 MB — inline text files below this

// ─── Vision capability detection (Hermes-style) ────────────────────────────

/**
 * Known vision-capable model ID prefixes / substrings.
 * Used when visionMode is 'auto' to decide between native pixels and text
 * annotations. This is a best-effort heuristic — users can always force
 * 'native' or 'text' per model config.
 */
const VISION_MODEL_PATTERNS = [
  // Anthropic — Claude 3+ all support vision
  'claude-3', 'claude-4', 'claude-opus', 'claude-sonnet', 'claude-haiku',
  'claude-3-5', 'claude-3.5',
  // OpenAI vision models
  'gpt-4o', 'gpt-4-turbo', 'gpt-4-vision', 'gpt-4.1',
  'o1', 'o3', 'o4',
  // Google
  'gemini-1.5', 'gemini-2', 'gemini-2.5', 'gemini-pro-vision',
  // Alibaba
  'qwen-vl', 'qwen2-vl', 'qvq',
  // Zhipu
  'glm-4v',
  // Open-source vision
  'llava', 'pixtral', 'bakllava', 'cogvlm', 'internvl', 'minicpm-v',
  // Moonshot
  'kimi',
  // Grok
  'grok',
  // Mistral
  'mistral', 'codestral',
]

/**
 * Resolve the effective vision mode from the config string and model ID.
 * Mirrors Hermes Agent's `decide_image_input_mode()`.
 *
 * - 'native' → always return 'native' (caller is responsible for fallback on error)
 * - 'text'   → always return 'text' (safe text annotations)
 * - 'auto'   → check model ID against known vision patterns; 'native' if matched, 'text' otherwise
 */
export function resolveVisionMode(
  modelId: string,
  visionMode: string
): 'native' | 'text' {
  if (visionMode === 'native') return 'native'
  if (visionMode === 'text') return 'text'
  // 'auto' — detect
  const lower = modelId.toLowerCase()
  for (const pat of VISION_MODEL_PATTERNS) {
    if (lower.includes(pat)) return 'native'
  }
  return 'text'
}

function isImage(meta: AttachmentMeta): boolean {
  return IMAGE_EXTS.has(extname(meta.name).toLowerCase()) ||
    meta.mimeType.startsWith('image/')
}

function isTextFile(meta: AttachmentMeta): boolean {
  return TEXT_EXTS.has(extname(meta.name).toLowerCase()) ||
    meta.mimeType.startsWith('text/')
}

/** Human-readable file size. */
function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1_048_576) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Build Anthropic content blocks from a ChatMessage.
 * Returns a plain string if there are no attachments (backward compat).
 *
 * @param visionMode — 'native' sends real image blocks; 'text' sends metadata annotations.
 */
export function toAnthropicContent(
  m: ChatMessage,
  visionMode: 'native' | 'text' = 'text'
): string | Array<Record<string, unknown>> {
  if (!m.attachments || m.attachments.length === 0) return m.content

  const blocks: Array<Record<string, unknown>> = []
  if (m.content.trim()) {
    blocks.push({ type: 'text', text: m.content })
  }

  for (const att of m.attachments) {
    try {
      const buf = readFileSync(att.path)
      if (isImage(att)) {
        if (visionMode === 'native') {
          const mediaType = att.mimeType || 'image/png'
          blocks.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: buf.toString('base64') }
          })
        } else {
          // Text fallback — metadata annotation so the model knows the file exists.
          // The ocr_image tool can extract text from this image.
          blocks.push({
            type: 'text',
            text: `[Image attached: ${att.name} (${att.mimeType || 'image'}, ${fmtSize(att.size)}); file path: ${att.path}. Use the ocr_image tool to extract text from this image, or the file-read tool if you need to inspect it further.]`
          })
        }
      } else if (isTextFile(att) && buf.length <= MAX_TEXT_FILE_BYTES) {
        blocks.push({
          type: 'text',
          text: `[File: ${att.name} (${fmtSize(att.size)})]\n\n${buf.toString('utf8')}`
        })
      } else {
        blocks.push({
          type: 'text',
          text: `[Attached file: ${att.name} (${fmtSize(att.size)}, ${att.mimeType || 'binary'}) — content not displayed inline]`
        })
      }
    } catch {
      blocks.push({ type: 'text', text: `[Attached file: ${att.name} (unreadable)]` })
    }
  }

  return blocks
}

/**
 * Build OpenAI content blocks from a ChatMessage.
 * Returns a plain string if there are no attachments (backward compat).
 *
 * @param visionMode — 'native' sends image_url blocks; 'text' sends metadata annotations.
 *                     Many OpenAI-compatible endpoints (proxies, local models, non-vision
 *                     models) reject image_url — use 'text' for those.
 */
export function toOpenAIContent(
  m: ChatMessage,
  visionMode: 'native' | 'text' = 'text'
): string | Array<Record<string, unknown>> {
  if (!m.attachments || m.attachments.length === 0) return m.content

  const blocks: Array<Record<string, unknown>> = []
  if (m.content.trim()) {
    blocks.push({ type: 'text', text: m.content })
  }

  for (const att of m.attachments) {
    try {
      const buf = readFileSync(att.path)
      if (isImage(att)) {
        if (visionMode === 'native') {
          const mediaType = att.mimeType || 'image/png'
          blocks.push({
            type: 'image_url',
            image_url: { url: `data:${mediaType};base64,${buf.toString('base64')}` }
          })
        } else {
          blocks.push({
            type: 'text',
            text: `[Image attached: ${att.name} (${att.mimeType || 'image'}, ${fmtSize(att.size)}); the image file is on disk at ${att.path}. Use the file-read tool if you need to inspect it further.]`
          })
        }
      } else if (isTextFile(att) && buf.length <= MAX_TEXT_FILE_BYTES) {
        blocks.push({
          type: 'text',
          text: `[File: ${att.name} (${fmtSize(att.size)})]\n\n${buf.toString('utf8')}`
        })
      } else {
        blocks.push({
          type: 'text',
          text: `[Attached file: ${att.name} (${fmtSize(att.size)}, ${att.mimeType || 'binary'}) — content not displayed inline]`
        })
      }
    } catch {
      blocks.push({ type: 'text', text: `[Attached file: ${att.name} (unreadable)]` })
    }
  }

  return blocks
}
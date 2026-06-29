import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall
} from 'openai/resources/chat/completions'
import { openaiClient } from '../OpenAIClient'
import { configStore } from '../../config/store'
import type { AgentTool } from '../../tools/types'
import type { ChatMessage } from '@shared/ipc'
import {
  type AgentCallbacks,
  type AgentRunner,
  type RunContext,
  executeToolCall,
  toOpenAIContent,
  resolveVisionMode,
  trimMessages,
  buildWrapUpPrompt,
  MAX_TOKENS,
  MAX_TURNS,
  WRAP_UP_TURN
} from './types'
import { memoryService } from '../../memory/MemoryService'

/** Accumulates streamed tool-call fragments keyed by their stream index. */
interface PartialToolCall {
  id: string
  name: string
  args: string
}

/** Manual agentic loop over the OpenAI Chat Completions API (streaming). */
export class OpenAIRunner implements AgentRunner {
  async run(
    runId: string,
    history: ChatMessage[],
    tools: AgentTool[],
    cb: AgentCallbacks,
    ctx?: RunContext
  ): Promise<void> {
    const settings = configStore.getSettings()
    const sdkTools: ChatCompletionTool[] = tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as unknown as Record<string, unknown>
      }
    }))
    const effectiveModel = ctx?.modelOverride ?? settings.model
    const effectiveVision = resolveVisionMode(effectiveModel, ctx?.visionModeOverride ?? 'text')
    const messages: ChatCompletionMessageParam[] = history
      .map((m) => {
        const content = m.attachments?.length ? toOpenAIContent(m, effectiveVision) : m.content
        return {
          role: m.role as 'user' | 'assistant',
          content
        }
      }) as ChatCompletionMessageParam[]
    // OpenAI Chat Completions has no first-class system field; prepend one.
    if (ctx?.system) messages.unshift({ role: 'system', content: ctx.system })
    let finalText = ''

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (cb.isCancelled()) return cb.emit({ type: 'cancelled', runId })

      // Inject wrap-up nudge near the turn limit
      if (turn === WRAP_UP_TURN) {
        messages.push({ role: 'user', content: buildWrapUpPrompt() })
      }

      // Trim old messages before they overflow the model context window
      trimMessages(messages as Array<{ role: string; content: unknown }>)

      const model = ctx?.modelOverride ?? settings.model
      const { text, toolCalls, usage } = await this.streamOnce(runId, model, messages, sdkTools, cb, ctx)
      if (cb.isCancelled()) return cb.emit({ type: 'cancelled', runId })
      if (text) finalText = text

      // Emit per-turn token usage
      if (usage) {
        cb.emit({
          type: 'token_usage',
          runId,
          inputTokens: usage.prompt_tokens,
          outputTokens: usage.completion_tokens
        })
      }

      if (toolCalls.length === 0) {
        // Fire-and-forget memory extraction (don't block the done event)
        if (ctx?.sessionId) {
          memoryService.extractAndStore(history, effectiveModel, 'openai', ctx.sessionId, ctx?.apiKeyOverride, ctx?.baseUrlOverride)
        }
        return cb.emit({ type: 'done', runId, finalText })
      }

      // Append assistant turn carrying the tool calls.
      const assistantToolCalls: ChatCompletionMessageToolCall[] = toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args || '{}' }
      }))
      messages.push({ role: 'assistant', content: text || null, tool_calls: assistantToolCalls })

      // If we're past the wrap-up turn and the model keeps calling tools, force stop
      if (turn >= WRAP_UP_TURN && toolCalls.length > 0) {
        for (const tc of toolCalls) {
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            content: 'Tool call declined — conversation turn limit reached. Please deliver your final answer now.'
          })
        }
        continue
      }

      for (const tc of toolCalls) {
        if (cb.isCancelled()) return cb.emit({ type: 'cancelled', runId })
        const input = this.parseArgs(tc.args)
        const outcome = await executeToolCall(runId, { id: tc.id, name: tc.name, input }, tools, cb, ctx)
        messages.push({
          role: 'tool',
          tool_call_id: outcome.id,
          content: outcome.isError ? `Error: ${outcome.content}` : outcome.content
        })
      }
    }
    // Fire-and-forget memory extraction (don't block the done event)
    if (ctx?.sessionId) {
      memoryService.extractAndStore(history, effectiveModel, 'openai', ctx.sessionId)
    }
    cb.emit({ type: 'done', runId, finalText })
  }

  private parseArgs(args: string): unknown {
    try {
      return args.trim() ? JSON.parse(args) : {}
    } catch {
      return {}
    }
  }

  private async streamOnce(
    runId: string,
    model: string,
    messages: ChatCompletionMessageParam[],
    tools: ChatCompletionTool[],
    cb: AgentCallbacks,
    ctx?: RunContext
  ): Promise<{ text: string; toolCalls: PartialToolCall[]; usage: { prompt_tokens: number; completion_tokens: number } | null }> {
    const client = openaiClient.get({
      apiKey: ctx?.apiKeyOverride,
      baseURL: ctx?.baseUrlOverride
    })
    const stream = await client.chat.completions.create({
      model,
      max_tokens: MAX_TOKENS,
      messages,
      tools: tools.length ? tools : undefined,
      stream: true,
      stream_options: { include_usage: true }
    })

    let text = ''
    let usage: { prompt_tokens: number; completion_tokens: number } | null = null
    const byIndex = new Map<number, PartialToolCall>()
    const emittedToolUse = new Set<number>()

    for await (const chunk of stream) {
      if (cb.isCancelled()) {
        stream.controller.abort()
        break
      }
      // Capture usage from the final chunk (stream_options: include_usage)
      if (chunk.usage) {
        usage = {
          prompt_tokens: chunk.usage.prompt_tokens,
          completion_tokens: chunk.usage.completion_tokens
        }
      }
      const delta = chunk.choices[0]?.delta
      if (!delta) continue

      if (delta.content) {
        text += delta.content
        cb.emit({ type: 'text_delta', runId, text: delta.content })
      }
      // Some OpenAI-compatible reasoning endpoints expose reasoning_content.
      const reasoning = (delta as { reasoning_content?: string }).reasoning_content
      if (reasoning) cb.emit({ type: 'thinking_delta', runId, text: reasoning })

      if (delta.tool_calls) {
        for (const part of delta.tool_calls) {
          const idx = part.index ?? 0
          let acc = byIndex.get(idx)
          if (!acc) {
            acc = { id: part.id ?? '', name: '', args: '' }
            byIndex.set(idx, acc)
          }
          if (part.id) acc.id = part.id
          if (part.function?.name) acc.name += part.function.name
          if (part.function?.arguments) acc.args += part.function.arguments
        }
      }
    }

    // Emit tool_use events once names are fully assembled.
    const toolCalls = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, tc]) => {
        if (tc.name && !emittedToolUse.has(idx)) {
          emittedToolUse.add(idx)
          cb.emit({ type: 'tool_use', runId, toolName: tc.name, input: this.parseArgs(tc.args), id: tc.id })
        }
        return tc
      })
      .filter((tc) => tc.name)

    return { text, toolCalls, usage }
  }
}

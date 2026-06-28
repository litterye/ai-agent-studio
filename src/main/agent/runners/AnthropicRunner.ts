import type Anthropic from '@anthropic-ai/sdk'
import type { MessageParam, Tool, ToolUseBlock } from '@anthropic-ai/sdk/resources/messages'
import { anthropicClient } from '../AnthropicClient'
import { configStore } from '../../config/store'
import type { AgentTool } from '../../tools/types'
import type { ChatMessage } from '@shared/ipc'
import {
  type AgentCallbacks,
  type AgentRunner,
  type RunContext,
  executeToolCall,
  toAnthropicContent,
  resolveVisionMode,
  trimMessages,
  buildWrapUpPrompt,
  MAX_TOKENS,
  MAX_TURNS,
  WRAP_UP_TURN
} from './types'
import { memoryService } from '../../memory/MemoryService'

/** Manual agentic loop over the Anthropic Messages API (streaming). */
export class AnthropicRunner implements AgentRunner {
  async run(
    runId: string,
    history: ChatMessage[],
    tools: AgentTool[],
    cb: AgentCallbacks,
    ctx?: RunContext
  ): Promise<void> {
    const settings = configStore.getSettings()
    const sdkTools: Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Tool.InputSchema
    }))
    const effectiveModel = ctx?.modelOverride ?? settings.model
    const effectiveVision = resolveVisionMode(effectiveModel, ctx?.visionModeOverride ?? 'text')
    const messages: MessageParam[] = history.map((m) => ({
      role: m.role,
      content: m.attachments?.length ? toAnthropicContent(m, effectiveVision) : m.content
    }))
    let finalText = ''
    let totalInputTokens = 0
    let totalOutputTokens = 0

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (cb.isCancelled()) return cb.emit({ type: 'cancelled', runId })

      // Inject wrap-up nudge near the turn limit
      if (turn === WRAP_UP_TURN) {
        messages.push({ role: 'user', content: buildWrapUpPrompt() })
      }

      // Trim old messages before they overflow the model context window
      trimMessages(messages as Array<{ role: string; content: unknown }>)

      const message = await this.streamOnce(runId, settings, messages, sdkTools, cb, ctx)
      if (cb.isCancelled()) return cb.emit({ type: 'cancelled', runId })

      // Emit per-turn token usage
      if (message.usage) {
        totalInputTokens += message.usage.input_tokens
        totalOutputTokens += message.usage.output_tokens
        cb.emit({
          type: 'token_usage',
          runId,
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens
        })
      }

      const turnText = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('')
      if (turnText) finalText = turnText

      if (message.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: message.content })
        continue
      }
      if (message.stop_reason !== 'tool_use') {
        // Fire-and-forget memory extraction (don't block the done event)
        if (ctx?.sessionId) {
          memoryService.extractAndStore(history, effectiveModel, 'anthropic', ctx.sessionId)
        }
        return cb.emit({ type: 'done', runId, finalText })
      }

      messages.push({ role: 'assistant', content: message.content })
      const toolUses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')

      // If we're past the wrap-up turn and the model keeps calling tools, force stop
      if (turn >= WRAP_UP_TURN && toolUses.length > 0) {
        const declined: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => ({
          type: 'tool_result' as const,
          tool_use_id: tu.id,
          content: 'Tool call declined — conversation turn limit reached. Please deliver your final answer now.',
          is_error: true
        }))
        messages.push({ role: 'user', content: declined })
        continue
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = []

      for (const tu of toolUses) {
        if (cb.isCancelled()) return cb.emit({ type: 'cancelled', runId })
        const outcome = await executeToolCall(
          runId,
          { id: tu.id, name: tu.name, input: tu.input },
          tools,
          cb,
          ctx
        )
        toolResults.push({
          type: 'tool_result',
          tool_use_id: outcome.id,
          content: outcome.content,
          is_error: outcome.isError
        })
      }
      messages.push({ role: 'user', content: toolResults })
    }
    // Fire-and-forget memory extraction (don't block the done event)
    if (ctx?.sessionId) {
      memoryService.extractAndStore(history, effectiveModel, 'anthropic', ctx.sessionId)
    }
    cb.emit({ type: 'done', runId, finalText })
  }

  private async streamOnce(
    runId: string,
    settings: { model: string; effort: string },
    messages: MessageParam[],
    tools: Tool[],
    cb: AgentCallbacks,
    ctx?: RunContext
  ): Promise<Anthropic.Message> {
    const client = anthropicClient.get()
    const model = ctx?.modelOverride ?? settings.model
    const effort = ctx?.effortOverride ?? settings.effort
    const params = {
      model,
      max_tokens: MAX_TOKENS,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort },
      tools: tools.length ? tools : undefined,
      system: ctx?.system,
      messages
    }
    const stream = client.messages.stream(
      params as unknown as Parameters<typeof client.messages.stream>[0]
    )

    stream.on('text', (delta) => {
      if (!cb.isCancelled()) cb.emit({ type: 'text_delta', runId, text: delta })
    })
    stream.on('thinking', (delta) => {
      if (!cb.isCancelled()) cb.emit({ type: 'thinking_delta', runId, text: delta })
    })
    stream.on('contentBlock', (block) => {
      if (block.type === 'tool_use' && !cb.isCancelled()) {
        cb.emit({ type: 'tool_use', runId, toolName: block.name, input: block.input, id: block.id })
      }
    })

    if (cb.isCancelled()) stream.abort()
    return await stream.finalMessage()
  }
}

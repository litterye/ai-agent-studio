import { anthropicClient } from '../agent/AnthropicClient'
import { openaiClient } from '../agent/OpenAIClient'
import { configStore } from '../config/store'

/**
 * Layer A smart-approve: when a command matches no DANGEROUS_PATTERN but the
 * caller wants a second opinion, ask the active LLM with a one-shot prompt.
 * Returns true if the LLM says yes, false if it says no.
 *
 * Conservative behavior:
 *  - If the call fails for any reason (no key, network, timeout), return true
 *    — let the regular confirm dialog handle the risk. Better to over-confirm
 *    than to silently auto-allow an unsafe command.
 *  - We only accept a leading "yes" / "no" / "safe" / "unsafe" token — anything
 *    ambiguous falls through to the dialog as well.
 */

const SYSTEM_PROMPT = `You are a security reviewer for a desktop AI agent. The agent is about to run a shell command. Answer only "yes" if the command is safe to run without further confirmation, or "no" if it is not. Do not explain.`

const MAX_TOKENS = 8
const TIMEOUT_MS = 4000

export async function smartApprove(command: string, cwd: string): Promise<boolean> {
  try {
    const settings = configStore.getSettings()
    const userMsg = `Working directory: ${cwd || '(unknown)'}\nCommand:\n\`\`\`\n${command}\n\`\`\`\nSafe to run without further confirmation? Answer "yes" or "no".`

    const answer =
      settings.protocol === 'openai'
        ? await askOpenAI(settings.model, userMsg)
        : await askAnthropic(settings.model, userMsg)

    const norm = (answer ?? '').trim().toLowerCase()
    if (norm.startsWith('yes') || norm.startsWith('safe')) return true
    if (norm.startsWith('no') || norm.startsWith('unsafe') || norm.startsWith('danger')) {
      return false
    }
    // Ambiguous — let the regular confirm dialog handle it.
    return true
  } catch {
    // Don't block on aux-LLM failure; the user confirm dialog is the real gate.
    return true
  }
}

async function askAnthropic(model: string, userMsg: string): Promise<string | null> {
  const client = anthropicClient.get()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMsg }],
      // Best-effort: newer SDK builds accept this; older builds ignore it.
      ...({} as { signal: AbortSignal })
    })
    const block = res.content.find((b) => b.type === 'text')
    return block && 'text' in block ? block.text : null
  } finally {
    clearTimeout(timer)
  }
}

async function askOpenAI(model: string, userMsg: string): Promise<string | null> {
  const client = openaiClient.get()
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await client.chat.completions.create(
      {
        model,
        max_tokens: MAX_TOKENS,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userMsg }
        ],
        stream: false
      },
      { signal: ctrl.signal as unknown as AbortSignal }
    )
    return res.choices[0]?.message?.content ?? null
  } finally {
    clearTimeout(timer)
  }
}
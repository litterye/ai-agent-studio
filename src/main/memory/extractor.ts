import type { ChatMessage } from '@shared/ipc'
import { anthropicClient } from '../agent/AnthropicClient'
import { openaiClient } from '../agent/OpenAIClient'
import { memoryStore } from '../db/memoryStore'

export interface MemoryCandidate {
  type: 'fact' | 'preference' | 'feedback' | 'learning'
  content: string
  keywords: string
  importance: number
}

const EXTRACTION_PROMPT = `You are a memory extraction system. Analyze this conversation exchange and identify any information worth remembering for future interactions. Return a JSON array of memory objects.

A memory should be saved when:
- fact: The user states a concrete fact about themselves, their environment, or their work ("I use Windows", "Our codebase is at D:/project", "We use React 18")
- preference: The user expresses a preference or style request ("I prefer TypeScript over JavaScript", "Keep answers short and direct", "Show code in Python not Go")
- feedback: The user gives feedback on your behavior or output quality ("That explanation was too verbose", "The last answer was exactly what I needed", "Don't use emojis in responses")
- learning: You discover something reusable about the codebase or workflow ("The build command is npm run build", "Tests must pass before merging", "Port 3000 is already in use")

Return ONLY a valid JSON array. Each object must have:
- "type": one of "fact", "preference", "feedback", "learning"
- "content": a clear, self-contained statement (1-3 sentences) that would make sense when read in isolation months later
- "keywords": 3-8 comma-separated keywords or short phrases in English (and Chinese if relevant) that someone might search for to find this memory
- "importance": integer 1-10 (10=critical identity/preference, 7-8=important workflow fact, 5-6=useful context, 3-4=minor detail, 1-2=barely noteworthy)

IMPORTANT: Be selective. Return [] for trivial exchanges (greetings, chitchat, simple Q&A). Only save information that would genuinely help in future conversations.

Conversation:
[User]: {user}
[Assistant]: {assistant}

Return JSON array only (no markdown fences, no explanations):`

/**
 * Fire-and-forget extraction: given the last user+assistant exchange,
 * ask the LLM to identify memory-worthy information, deduplicate, and store.
 *
 * Failures are silent — extraction never affects the main conversation.
 */
export async function extractMemories(
  history: ChatMessage[],
  model: string,
  protocol: string,
  apiKey?: string,
  baseURL?: string
): Promise<MemoryCandidate[]> {
  try {
    // Grab the last user message and assistant response
    const userMsgs = history.filter((m) => m.role === 'user')
    const assistantMsgs = history.filter((m) => m.role === 'assistant')
    if (userMsgs.length === 0 || assistantMsgs.length === 0) return []

    const lastUser = userMsgs[userMsgs.length - 1].content.trim()
    const lastAssistant = assistantMsgs[assistantMsgs.length - 1].content.trim()
    if (!lastUser || !lastAssistant) return []
    // Skip trivial exchanges
    if (lastUser.length < 10 && lastAssistant.length < 100) return []

    const prompt = EXTRACTION_PROMPT
      .replace('{user}', lastUser.slice(0, 3000))
      .replace('{assistant}', lastAssistant.slice(0, 6000))

    const raw = protocol === 'openai'
      ? await askOpenAI(model, prompt, apiKey, baseURL)
      : await askAnthropic(model, prompt, apiKey, baseURL)

    if (!raw) return []

    // Parse JSON — handle models that wrap in markdown fences
    let json = raw.trim()
    json = json.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
    // Find the first '[' and last ']' in case the model added commentary
    const start = json.indexOf('[')
    const end = json.lastIndexOf(']')
    if (start === -1 || end === -1) return []
    json = json.slice(start, end + 1)

    const parsed = JSON.parse(json) as Array<{ type?: string; content?: string; keywords?: string; importance?: number }>
    if (!Array.isArray(parsed)) return []

    const candidates: MemoryCandidate[] = []
    const validTypes = new Set(['fact', 'preference', 'feedback', 'learning'])

    for (const item of parsed) {
      const type = item.type?.toLowerCase()
      if (!type || !validTypes.has(type)) continue
      const content = item.content?.trim()
      if (!content || content.length < 5) continue
      const keywords = item.keywords?.trim() ?? ''
      const importance = Math.max(1, Math.min(10, Math.round(item.importance ?? 5)))

      // Dedup: skip if very similar to existing memory
      if (memoryStore.existsSimilar(content)) continue

      candidates.push({
        type: type as MemoryCandidate['type'],
        content,
        keywords,
        importance
      })
    }

    return candidates
  } catch (err) {
    // Silent failure — extraction is best-effort
    console.error('[memory] extractMemories error:', err)
    return []
  }
}

async function askAnthropic(model: string, content: string, apiKey?: string, baseURL?: string): Promise<string | null> {
  try {
    const client = anthropicClient.get({ apiKey, baseURL })
    const res = await client.messages.create({
      model,
      max_tokens: 2000,
      temperature: 0.3, // Low temp for deterministic extraction
      messages: [{ role: 'user', content }]
    })
    const block = res.content.find((b) => b.type === 'text')
    return block && 'text' in block ? block.text : null
  } catch (err) {
    console.error('[memory] askAnthropic error:', err)
    return null
  }
}

async function askOpenAI(model: string, content: string, apiKey?: string, baseURL?: string): Promise<string | null> {
  try {
    const client = openaiClient.get({ apiKey, baseURL })
    const res = await client.chat.completions.create({
      model,
      max_tokens: 2000,
      temperature: 0.3,
      messages: [{ role: 'user', content }],
      stream: false
    })
    return res.choices[0]?.message?.content ?? null
  } catch (err) {
    console.error('[memory] askOpenAI error:', err)
    return null
  }
}

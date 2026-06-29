import OpenAI from 'openai'
import { configStore } from '../config/store'

/**
 * Builds an OpenAI-protocol client (works with OpenAI and any OpenAI-compatible
 * endpoint via baseURL), recreating it when key or baseURL changes.
 *
 * Accepts per-model overrides (apiKey, baseURL) so that model-specific keys
 * stored in the ModelStore can be used instead of the global ConfigStore key.
 */
export class OpenAIClient {
  private client: OpenAI | null = null
  private signature: string | null = null

  get(overrides?: { apiKey?: string; baseURL?: string }): OpenAI {
    // Per-model key overrides take priority, then fall back to global config.
    const key = overrides?.apiKey || configStore.resolveKey()
    if (!key) {
      throw new Error('未配置 API Key。请在模型设置中填入，或设置 OPENAI_API_KEY 环境变量。')
    }
    const baseURL = overrides?.baseURL || configStore.resolveBaseUrl()
    const sig = `${key}::${baseURL ?? ''}`
    if (!this.client || this.signature !== sig) {
      this.client = new OpenAI(baseURL ? { apiKey: key, baseURL } : { apiKey: key })
      this.signature = sig
    }
    return this.client
  }
}

export const openaiClient = new OpenAIClient()

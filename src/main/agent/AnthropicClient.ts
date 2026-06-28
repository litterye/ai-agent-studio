import Anthropic from '@anthropic-ai/sdk'
import { configStore } from '../config/store'

/**
 * Builds an Anthropic client from the resolved key + optional custom baseURL,
 * recreating it when either changes. Throws if no key is configured.
 */
export class AnthropicClient {
  private client: Anthropic | null = null
  private signature: string | null = null

  get(): Anthropic {
    const key = configStore.resolveKey()
    if (!key) {
      throw new Error('未配置 API Key。请在设置中填入，或设置 ANTHROPIC_API_KEY 环境变量。')
    }
    const baseURL = configStore.resolveBaseUrl()
    const sig = `${key}::${baseURL ?? ''}`
    if (!this.client || this.signature !== sig) {
      this.client = new Anthropic(baseURL ? { apiKey: key, baseURL } : { apiKey: key })
      this.signature = sig
    }
    return this.client
  }
}

export const anthropicClient = new AnthropicClient()

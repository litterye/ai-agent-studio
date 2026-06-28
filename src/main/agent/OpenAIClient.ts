import OpenAI from 'openai'
import { configStore } from '../config/store'

/**
 * Builds an OpenAI-protocol client (works with OpenAI and any OpenAI-compatible
 * endpoint via baseURL), recreating it when key or baseURL changes.
 */
export class OpenAIClient {
  private client: OpenAI | null = null
  private signature: string | null = null

  get(): OpenAI {
    const key = configStore.resolveKey()
    if (!key) {
      throw new Error('未配置 API Key。请在设置中填入，或设置 OPENAI_API_KEY 环境变量。')
    }
    const baseURL = configStore.resolveBaseUrl()
    const sig = `${key}::${baseURL ?? ''}`
    if (!this.client || this.signature !== sig) {
      this.client = new OpenAI(baseURL ? { apiKey: key, baseURL } : { apiKey: key })
      this.signature = sig
    }
    return this.client
  }
}

export const openaiClient = new OpenAIClient()

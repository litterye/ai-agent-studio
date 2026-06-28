import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  url: z.string().describe('The URL to fetch. HTTP is upgraded to HTTPS automatically.'),
  prompt: z
    .string()
    .describe(
      'What information to extract from the page. The full page HTML will be ' +
        'converted to plain text, then a model will answer this question using ' +
        'the extracted text as context.'
    )
})

type Input = z.infer<typeof schema>

const MAX_CONTENT_BYTES = 500 * 1024
const REQUEST_TIMEOUT_MS = 15_000

/**
 * Strip HTML tags, decode entities, collapse whitespace, and trim each line.
 * Returns a readable plain-text representation of the page body.
 */
function htmlToPlainText(html: string): string {
  // Remove script/style/head/noscript/iframe/svg elements
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<head[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')

  // Replace block-level tags with newlines
  text = text.replace(/<\/(div|p|h[1-6]|li|tr|article|section|header|main|aside|table|ul|ol|dl|blockquote|pre|hr|br)[^>]*>/gi, '\n')
  text = text.replace(/<(div|p|h[1-6]|li|tr|article|section|header|main|aside|table|ul|ol|dl|blockquote|pre|hr|br)[^>]*>/gi, '\n')

  // Remove remaining HTML tags
  text = text.replace(/<[^>]+>/g, '')

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_m, d) => String.fromCharCode(Number(d)))

  // Collapse runs of whitespace and trim lines
  text = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0)
    .join('\n')

  return text
}

const def: BuiltinToolDef<Input> = {
  name: 'WebFetch',
  description:
    'Fetches a URL, converts the page to plain text, and answers a prompt against it. ' +
    'Use this to read web pages, documentation, or API responses. ' +
    'Fails on authenticated/private URLs. HTTP is upgraded to HTTPS. ' +
    'Cross-host redirects are reported to the caller. ' +
    'Responses are cached for 15 minutes per URL.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to fetch. HTTP is upgraded to HTTPS automatically.'
      },
      prompt: {
        type: 'string',
        description: 'What information to extract from the page.'
      }
    },
    required: ['url', 'prompt'],
    additionalProperties: false
  },
  toolset: 'web',
  needsConfirmation: false,
  emoji: '🌐',
  maxResultSizeChars: 80_000,
  async handler(input) {
    // Normalise URL: upgrade http → https, add https:// if missing
    let url = input.url.trim()
    if (!/^https?:\/\//i.test(url)) {
      url = 'https://' + url
    }
    if (url.startsWith('http://')) {
      url = 'https://' + url.slice(7)
    }

    // Validate URL
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      throw new Error(`Invalid URL: ${url}`)
    }
    if (!['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}. Only HTTP(S) is supported.`)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'AI-Agent-Studio/1.0 (web-fetch)',
          Accept: 'text/html, application/xhtml+xml, text/plain, */*'
        },
        redirect: 'manual'
      })

      // Report redirects — the caller can re-fetch
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location')
        throw new Error(
          `Redirected to ${loc ?? 'unknown location'} (status ${res.status}). ` +
            'Fetch the redirect target directly.'
        )
      }

      if (res.status === 403 || res.status === 401) {
        throw new Error(`Access denied (HTTP ${res.status}). This URL may require authentication.`)
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/') && !contentType.includes('application/json') && !contentType.includes('application/xml') && !contentType.includes('application/xhtml')) {
        throw new Error(
          `Unsupported content type: ${contentType}. Only text/*, application/json, ` +
            'and application/xml are supported.'
        )
      }

      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.byteLength > MAX_CONTENT_BYTES) {
        throw new Error(
          `Content too large (${buf.byteLength} bytes, max ${MAX_CONTENT_BYTES}).`
        )
      }

      let body: string
      if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
        body = htmlToPlainText(buf.toString('utf-8'))
      } else if (contentType.includes('application/json')) {
        // Pretty-print JSON
        const obj = JSON.parse(buf.toString('utf-8'))
        body = JSON.stringify(obj, null, 2)
      } else {
        body = buf.toString('utf-8')
      }

      if (!body.trim()) {
        return 'The page returned no readable text content.'
      }

      // Return the plain text with the prompt included — the LLM will answer
      // the prompt based on the content.
      const truncated =
        body.length > 60_000
          ? body.slice(0, 60_000) + `\n\n[... truncated ${body.length - 60_000} chars ...]`
          : body

      return `## URL: ${url}\n## Prompt: ${input.prompt}\n\n## Page Content:\n\n${truncated}`
    } finally {
      clearTimeout(timer)
    }
  }
}

export function createWebFetchTool(): AgentTool {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.jsonSchema,
    source: 'builtin',
    toolset: def.toolset,
    needsConfirmation: def.needsConfirmation ?? false,
    emoji: def.emoji,
    maxResultSizeChars: def.maxResultSizeChars,
    async run(input: unknown): Promise<string> {
      const parsed = def.schema.parse(input)
      return def.handler(parsed)
    }
  }
}

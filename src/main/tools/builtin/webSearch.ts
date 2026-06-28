import { z } from 'zod'
import type { AgentTool, BuiltinToolDef } from '../types'

const schema = z.object({
  query: z.string().describe('The search query.'),
  allowed_domains: z
    .array(z.string())
    .optional()
    .describe('Only include search results from these domains (e.g. ["github.com", "docs.python.org"]).'),
  blocked_domains: z
    .array(z.string())
    .optional()
    .describe('Exclude search results from these domains.')
})

type Input = z.infer<typeof schema>

const REQUEST_TIMEOUT_MS = 12_000
const MAX_RESULTS = 10

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Use DuckDuckGo's HTML (non-JS) search endpoint. Returns a page of
 * structured results without needing an API key.
 */
async function ddgSearch(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query })
  const url = `https://lite.duckduckgo.com/lite/?${params.toString()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'AI-Agent-Studio/1.0 (web-search)',
        Accept: 'text/html'
      }
    })

    if (!res.ok) {
      throw new Error(`Search returned HTTP ${res.status}`)
    }

    const html = await res.text()
    return parseDDGLite(html)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse DuckDuckGo Lite HTML results into structured objects.
 *
 * DDG Lite renders results in a table with links of class "result-link"
 * and snippets in <td> elements with class "result-snippet". Each row
 * anchors (<a>) have relative hrefs that DDG redirects through.
 */
function parseDDGLite(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // DDG Lite pattern: each result is a <tr> containing:
  //   <td><a rel="nofollow" class="result-link" href="...">Title</a></td>
  //   <td class="result-snippet">Snippet text</td>
  //
  // The href may be a DDG redirect like
  //   //duckduckgo.com/l/?uddg=https://example.com&...
  // or a direct link. We extract the real URL.

  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi
  const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i

  const rows = html.match(rowRegex) ?? []

  for (const row of rows) {
    const linkMatch = linkRegex.exec(row)
    if (!linkMatch) continue

    let href = linkMatch[1]
    const title = stripTags(linkMatch[2]).trim()

    // Resolve DDG redirect URLs to the real destination
    href = resolveDDGRedirect(href)

    const snippetMatch = snippetRegex.exec(row)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : ''

    if (title && href) {
      results.push({ title, url: href, snippet })
    }
  }

  return results.slice(0, MAX_RESULTS)
}

/** Extract the real URL from a DDG redirect link. */
function resolveDDGRedirect(href: string): string {
  // Patterns:
  //   //duckduckgo.com/l/?uddg=https://example.com&rut=...
  //   https://duckduckgo.com/l/?uddg=https://...
  try {
    if (href.includes('uddg=')) {
      const match = href.match(/uddg=([^&]+)/)
      if (match) {
        return decodeURIComponent(match[1])
      }
    }
    // Relative protocol (//...)
    if (href.startsWith('//')) {
      href = 'https:' + href
    }
    return href
  } catch {
    return href
  }
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function filterResults(results: SearchResult[], allowed?: string[], blocked?: string[]): SearchResult[] {
  let filtered = results

  if (allowed && allowed.length > 0) {
    filtered = filtered.filter((r) => {
      try {
        const host = new URL(r.url).hostname
        return allowed.some((d) => host === d || host.endsWith('.' + d))
      } catch {
        return false
      }
    })
  }

  if (blocked && blocked.length > 0) {
    filtered = filtered.filter((r) => {
      try {
        const host = new URL(r.url).hostname
        return !blocked.some((d) => host === d || host.endsWith('.' + d))
      } catch {
        return true
      }
    })
  }

  return filtered
}

const def: BuiltinToolDef<Input> = {
  name: 'WebSearch',
  description:
    'Search the web using DuckDuckGo. Returns result blocks with titles, URLs, and snippets. ' +
    'Use this to find documentation, answer current-events questions, or research topics. ' +
    'Use `allowed_domains` or `blocked_domains` to filter results. ' +
    'US-only results. For more details from a result page, use WebFetch.',
  schema,
  jsonSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query.' },
      allowed_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Only include search results from these domains.'
      },
      blocked_domains: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exclude search results from these domains.'
      }
    },
    required: ['query'],
    additionalProperties: false
  },
  toolset: 'web',
  needsConfirmation: false,
  emoji: '🔍',
  maxResultSizeChars: 10_000,
  async handler(input) {
    const query = input.query.trim()
    if (!query) throw new Error('Query must not be empty.')
    if (query.length > 400) throw new Error('Query too long (max 400 chars).')

    const raw = await ddgSearch(query)
    const filtered = filterResults(raw, input.allowed_domains, input.blocked_domains)

    if (filtered.length === 0) {
      return `## WebSearch: "${query}"\n\nNo results found. ` +
        (input.allowed_domains?.length ? `(filtered to domains: ${input.allowed_domains.join(', ')})` : '') +
        (input.blocked_domains?.length ? `(excluded domains: ${input.blocked_domains.join(', ')})` : '')
    }

    const lines = filtered.map((r, i) =>
      `${i + 1}. **${r.title}**  \n   URL: ${r.url}\n   ${r.snippet}`
    )

    return `## WebSearch: "${query}"\nFound ${filtered.length} result(s)\n\n${lines.join('\n\n')}\n\n---\nSources: ${filtered.map(r => r.url).join(', ')}`
  }
}

export function createWebSearchTool(): AgentTool {
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

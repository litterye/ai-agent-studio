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
 * Search backends ordered by preference.
 * - Bing (cn.bing.com) — accessible in China, good Chinese + English results.
 * - DuckDuckGo (lite) — fallback for regions where Bing is blocked.
 */
const BACKENDS = [
  {
    name: 'bing',
    search: bingSearch
  },
  {
    name: 'ddg',
    search: ddgSearch
  }
]

async function trySearch(query: string): Promise<SearchResult[]> {
  for (const backend of BACKENDS) {
    try {
      const results = await backend.search(query)
      if (results.length > 0) return results
    } catch (err) {
      // Fall through to next backend
      console.warn(`[websearch] ${backend.name} failed:`, err)
    }
  }
  return []
}

// ─── Bing (cn.bing.com) — China-accessible ──────────────────────────────

async function bingSearch(query: string): Promise<SearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    setlang: 'zh-Hans',
    count: String(MAX_RESULTS)
  })
  const url = `https://cn.bing.com/search?${params.toString()}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
      }
    })

    if (!res.ok) {
      throw new Error(`Bing returned HTTP ${res.status}`)
    }

    const html = await res.text()
    return parseBingHtml(html)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Parse Bing search results HTML.
 *
 * Bing result structure:
 *   <li class="b_algo">
 *     <h2><a href="...">Title</a></h2>
 *     <div class="b_caption"><p>Snippet</p></div>
 *     <p class="b_lineclamp2">Extra snippet (optional)</p>
 *   </li>
 */
function parseBingHtml(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // Split on <li class="b_algo"> to isolate each result block
  const algoBlocks = html.split(/<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>/gi)
  // The first split chunk is page boilerplate — skip it
  for (let i = 1; i < algoBlocks.length; i++) {
    const block = algoBlocks[i]
    // Stop at next </li> to avoid cross-block bleed
    const endIdx = block.indexOf('</li>')
    const chunk = endIdx !== -1 ? block.slice(0, endIdx) : block

    // Extract title + URL from <h2><a>
    const linkMatch = chunk.match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue

    let href = linkMatch[1]
    // Resolve Bing redirect wrapper
    href = resolveBingRedirect(href)
    const title = stripTags(linkMatch[2]).trim()
    if (!title || !href) continue

    // Extract snippet — try b_caption first, then b_lineclamp2
    let snippet = ''
    const captionMatch = chunk.match(/<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
    if (captionMatch) {
      // Inside b_caption, look for <p> content
      const pMatch = captionMatch[1].match(/<p[^>]*>([\s\S]*?)<\/p>/i)
      if (pMatch) snippet = stripTags(pMatch[1]).trim()
    }
    if (!snippet) {
      const lineMatch = chunk.match(/<p[^>]*class="[^"]*b_lineclamp\d*[^"]*"[^>]*>([\s\S]*?)<\/p>/i)
      if (lineMatch) snippet = stripTags(lineMatch[1]).trim()
    }

    results.push({ title, url: href, snippet })
    if (results.length >= MAX_RESULTS) break
  }

  return results
}

/** Extract the real URL from Bing's redirect wrapper. */
function resolveBingRedirect(href: string): string {
  // Bing uses /ck/a?...&u=<encoded_url>&... pattern for click tracking
  try {
    if (href.includes('/ck/a') || href.includes('/search?') && href.includes('&u=')) {
      const match = href.match(/[?&]u=([^&]+)/)
      if (match) {
        return decodeURIComponent(match[1])
      }
    }
    return href
  } catch {
    return href
  }
}

// ─── DuckDuckGo (lite) — fallback backend ───────────────────────────────

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

function parseDDGLite(html: string): SearchResult[] {
  const results: SearchResult[] = []

  const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi
  const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/i

  const rows = html.match(rowRegex) ?? []

  for (const row of rows) {
    const linkMatch = linkRegex.exec(row)
    if (!linkMatch) continue

    let href = linkMatch[1]
    const title = stripTags(linkMatch[2]).trim()

    href = resolveDDGRedirect(href)

    const snippetMatch = snippetRegex.exec(row)
    const snippet = snippetMatch ? stripTags(snippetMatch[1]).trim() : ''

    if (title && href) {
      results.push({ title, url: href, snippet })
    }
  }

  return results.slice(0, MAX_RESULTS)
}

function resolveDDGRedirect(href: string): string {
  try {
    if (href.includes('uddg=')) {
      const match = href.match(/uddg=([^&]+)/)
      if (match) {
        return decodeURIComponent(match[1])
      }
    }
    if (href.startsWith('//')) {
      href = 'https:' + href
    }
    return href
  } catch {
    return href
  }
}

// ─── shared helpers ─────────────────────────────────────────────────────

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&#x3D;/g, '=')
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
    'Search the web using Bing (primary, China-accessible) with DuckDuckGo fallback. ' +
    'Returns result blocks with titles, URLs, and snippets. ' +
    'Use this to find documentation, answer current-events questions, or research topics. ' +
    'Use `allowed_domains` or `blocked_domains` to filter results.',
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

    const raw = await trySearch(query)
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

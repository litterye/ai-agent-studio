import { readFile, writeFile, stat, readdir } from 'fs/promises'
import { resolve, normalize, isAbsolute, relative, join } from 'path'
import type { FileBackend, ReadResult, DirEntry, SearchHit } from './fileOps'
import { isWriteDenied } from './fileSafety'

const DEFAULT_MAX_READ_BYTES = 1_000_000 // 1 MB

/**
 * Node-fs implementation. Every path operation consults the write/read
 * denylist before touching the disk.
 */
export const localBackend: FileBackend = {
  async read(absPath: string, maxBytes?: number): Promise<ReadResult> {
    const cap = maxBytes ?? DEFAULT_MAX_READ_BYTES
    try {
      const st = await stat(absPath)
      if (st.isDirectory()) return emptyResult(`Path is a directory: ${absPath}`)

      const total = st.size
      // Peek for binary detection.
      const buf = await readFile(absPath, { flag: 'r' })
      const isBin = containsNull(buf)

      const truncated = total > cap
      const raw = buf.toString('utf8', 0, truncated ? cap : total)
      return {
        content: raw,
        totalLines: raw.split('\n').length,
        fileSize: total,
        truncated,
        isBinary: isBin
      }
    } catch (err) {
      return emptyResult(err instanceof Error ? err.message : String(err))
    }
  },

  async write(absPath: string, content: string): Promise<void> {
    const reason = isWriteDenied(absPath)
    if (reason) throw new Error(`Write denied: ${reason}`)
    await writeFile(absPath, content, 'utf8')
  },

  async patch(
    absPath: string,
    patches: Array<{ oldText: string; newText: string }>
  ): Promise<boolean> {
    const raw = await this.read(absPath)
    if (raw.content === undefined || raw.error) return false
    let out = raw.content
    for (const p of patches) {
      const idx = out.indexOf(p.oldText)
      if (idx === -1) return false
      out = out.slice(0, idx) + p.newText + out.slice(idx + p.oldText.length)
    }
    await this.write(absPath, out)
    return true
  },

  async list(absPath: string): Promise<DirEntry[]> {
    const names = await readdir(absPath, { withFileTypes: true })
    const out: DirEntry[] = []
    for (const d of names) {
      let size = 0
      let modifiedMs = 0
      try {
        const s = await stat(join(absPath, d.name))
        size = s.size
        modifiedMs = s.mtimeMs
      } catch { /* stat may fail for dangling symlinks */ }
      out.push({
        name: d.name,
        kind: d.isDirectory() ? 'dir' : 'file',
        size,
        modifiedMs
      })
    }
    // Directories first, then alphabetically
    out.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return out
  },

  async search(
    absPath: string,
    query: string,
    globPattern?: string,
    maxResults = 30
  ): Promise<SearchHit[]> {
    const hits: SearchHit[] = []
    await walkSearch(absPath, query, globPattern, maxResults, hits)
    return hits
  },

  resolvePath(p: string, cwd: string): string {
    if (isAbsolute(p)) return normalize(p)
    return normalize(resolve(cwd || process.cwd(), p))
  }
}

function containsNull(buf: Buffer): boolean {
  // Only scan first 1024 bytes
  const end = Math.min(buf.length, 1024)
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

function emptyResult(error?: string): ReadResult {
  return { content: '', totalLines: 0, fileSize: 0, truncated: false, isBinary: false, error }
}

async function walkSearch(
  root: string,
  query: string,
  glob: string | undefined,
  max: number,
  hits: SearchHit[]
): Promise<void> {
  if (hits.length >= max) return
  let entries: DirEntry[]
  try {
    entries = await localBackend.list(root)
  } catch {
    return
  }
  for (const e of entries) {
    if (hits.length >= max) return
    const full = join(root, e.name)
    if (e.kind === 'dir') {
      if (['node_modules', '.git', '__pycache__', '.venv', 'dist'].includes(e.name)) continue
      await walkSearch(full, query, glob, max, hits)
    } else {
      if (glob && !matchSimpleGlob(e.name, glob)) continue
      try {
        const r = await localBackend.read(full)
        if (!r.content) continue
        const lines = r.content.split('\n')
        for (let i = 0; i < lines.length && hits.length < max; i++) {
          const idx = lines[i].indexOf(query)
          if (idx !== -1) {
            hits.push({
              path: relative(root, full),
              line: i + 1,
              column: idx + 1,
              lineContent: lines[i].slice(0, 300),
              match: query
            })
          }
        }
      } catch { /* skip */ }
    }
  }
}

/** Minimal glob matcher: "*.ts", "**\/*.js", literal "file.txt". */
function matchSimpleGlob(name: string, pattern: string): boolean {
  if (pattern === '*') return true
  // **/suffix
  const ds = pattern.lastIndexOf('**/')
  if (ds !== -1) {
    const suffix = pattern.slice(ds + 3)
    return name.endsWith(suffix)
  }
  // *.ext
  if (pattern.startsWith('*.')) {
    const ext = pattern.slice(1)
    return name.endsWith(ext)
  }
  // Literal match
  return name === pattern
}
/**
 * Abstract file-system interface so callers (builtins, policy) don't import
 * Node APIs directly. Backend is LocalFileBackend (see localBackend.ts); a
 * remote/sandbox backend could be swapped in later.
 */

export interface ReadResult {
  content: string
  totalLines: number
  fileSize: number
  truncated: boolean
  isBinary: boolean
  error?: string
}

export interface DirEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  modifiedMs: number
}

export interface SearchHit {
  path: string
  line: number
  column: number
  lineContent: string
  match: string
}

export interface FileBackend {
  read(absPath: string, maxBytes?: number): Promise<ReadResult>
  write(absPath: string, content: string): Promise<void>
  patch(absPath: string, patches: Array<{ oldText: string; newText: string }>): Promise<boolean>
  list(absPath: string): Promise<DirEntry[]>
  search(absPath: string, query: string, globPattern?: string, maxResults?: number): Promise<SearchHit[]>
  resolvePath(p: string, cwd: string): string
}
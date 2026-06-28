import { watch, type FSWatcher } from 'fs'
import { paths, ensureDir } from '../approvals/paths'
import { invalidateSkillsCache } from './promptBuilder'
import { scanSkills } from './scanner'

/**
 * Watches the skills directory for changes and invalidates the prompt-builder
 * cache. Re-scan is deferred to the next getSkills() call so a burst of writes
 * (e.g. git checkout) only triggers one rebuild.
 *
 * We use fs.watch (recursive where supported) instead of pulling in chokidar
 * to keep the dep surface small. Edge cases:
 *  - On Linux, recursive: true works on inotify-aware filesystems only.
 *  - On macOS, recursive: true is supported.
 *  - On Windows, recursive: true is supported but slow on huge trees.
 *  - Falls back to a non-recursive watch of the top-level dir.
 */

let _watcher: FSWatcher | null = null
let _debounce: NodeJS.Timeout | null = null

export function startSkillsWatcher(): void {
  if (_watcher) return
  ensureDir(paths.skillsDir)
  try {
    _watcher = watch(
      paths.skillsDir,
      { recursive: true, persistent: false },
      (_event, filename) => {
        if (!filename) return
        const name = filename.toString()
        if (name.endsWith('SKILL.md') || name.includes('SKILL.md')) {
          scheduleInvalidate()
        }
      }
    )
    _watcher.on('error', (err) => {
      console.error('[skills] watcher error', err)
    })
  } catch (err) {
    // Recursive not supported on this platform/FS — fall back to a non-recursive
    // top-level watch. Subdirectory changes will be missed until the next scan.
    console.error('[skills] recursive watch failed, using top-level only', err)
    try {
      _watcher = watch(paths.skillsDir, { persistent: false }, (_event, filename) => {
        if (filename?.toString().endsWith('SKILL.md')) scheduleInvalidate()
      })
    } catch (err2) {
      console.error('[skills] non-recursive watch also failed', err2)
    }
  }
}

export function stopSkillsWatcher(): void {
  if (_watcher) {
    _watcher.close()
    _watcher = null
  }
  if (_debounce) {
    clearTimeout(_debounce)
    _debounce = null
  }
}

function scheduleInvalidate(): void {
  if (_debounce) clearTimeout(_debounce)
  _debounce = setTimeout(() => {
    invalidateSkillsCache()
    // Warm the cache so the next read isn't slow.
    scanSkills()
  }, 250)
}

import { writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { isWriteDenied } from './fileSafety'

/**
 * Plan-writing utility. Plans are saved to `<cwd>/.plans/YYYY-MM-DD_HHMMSS-<slug>.md`.
 * Refuses if the cwd is in the write denylist.
 */
export function writePlan(
  cwd: string,
  slug: string,
  body: string
): { ok: true; path: string } | { ok: false; error: string } {
  if (isWriteDenied(cwd)) {
    return { ok: false, error: `cwd is in the write denylist: ${cwd}` }
  }

  const plansDir = join(cwd, '.plans')
  try {
    mkdirSync(plansDir, { recursive: true })
  } catch (err) {
    return { ok: false, error: `Cannot create .plans/ dir: ${String(err)}` }
  }

  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const ts = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '_',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('')
  const safeSlug = slug.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-{2,}/g, '-').slice(0, 80)
  const filename = `${ts}-${safeSlug}.md`
  const abs = join(plansDir, filename)

  try {
    writeFileSync(abs, body, 'utf8')
    return { ok: true, path: abs }
  } catch (err) {
    return { ok: false, error: `Failed to write plan: ${String(err)}` }
  }
}
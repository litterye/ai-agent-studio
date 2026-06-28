import type { Page } from 'playwright'
import { state } from './BrowserManager'

/** Build a compact or full text snapshot via DOM evaluation. */
export async function buildSnapshot(
  page: Page,
  mode: 'compact' | 'full' = 'compact'
): Promise<string> {
  state.refCounter = 0
  state.refMap.clear()

  const url = page.url()
  const title = await page.title().catch(() => '')

  const result = await page.evaluate((opts) => {
    const els = document.querySelectorAll(
      'a[href],button,input:not([type="hidden"]),select,textarea,' +
      '[role="button"],[role="link"],[role="textbox"],[role="searchbox"],' +
      '[role="combobox"],[role="listbox"],[role="menuitem"],[role="checkbox"],' +
      '[role="radio"],[role="switch"],[role="tab"],[role="option"],' +
      '[role="slider"],[role="spinbutton"],[role="treeitem"],[role="gridcell"],' +
      '[contenteditable="true"],[onclick],[data-action]'
    )

    const interactive: Array<{ idx: number; role: string; name: string; value: string; text: string; visible: boolean; disabled: boolean; checked: string; selected: boolean }> = []

    els.forEach((el) => {
      const tag = el.tagName.toLowerCase()
      const rect = el.getBoundingClientRect()
      const visible = rect.width > 0 && rect.height > 0
      if (!visible && opts.mode === 'compact') return

      const name = el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.getAttribute('placeholder') ||
        (el as HTMLElement).innerText?.slice(0, 60)?.trim() ||
        el.getAttribute('name') ||
        el.getAttribute('id') ||
        ''
      const value = (el as HTMLInputElement).value || ''
      const role = el.getAttribute('role') || tag
      const disabled = (el as HTMLButtonElement).disabled || false
      const checked = (el as HTMLInputElement).type === 'checkbox' || (el as HTMLInputElement).type === 'radio'
        ? String((el as HTMLInputElement).checked)
        : ''
      const selected = (el as HTMLOptionElement).selected || false
      const text = (el as HTMLElement).innerText?.slice(0, 80)?.trim() || ''

      interactive.push({
        idx: interactive.length,
        role,
        name: name.slice(0, 60),
        value: value.slice(0, 40),
        text: text.slice(0, 80),
        visible,
        disabled,
        checked,
        selected
      })
    })

    // Full-mode: also extract heading + paragraph text
    let fullText = ''
    if (opts.mode === 'full') {
      const body = document.body
      if (body) {
        fullText = body.innerText.slice(0, 12000)
      }
    }

    // Get all image info
    const images: Array<{ src: string; alt: string; w: number; h: number }> = []
    if (opts.mode === 'full') {
      document.querySelectorAll('img[src]').forEach((img) => {
        const el = img as HTMLImageElement
        const src = el.src || el.getAttribute('data-src') || ''
        if (src && (src.startsWith('http') || src.startsWith('data:'))) {
          images.push({ src, alt: el.alt || '', w: el.naturalWidth || el.width || 0, h: el.naturalHeight || el.height || 0 })
        }
      })
    }

    return { interactive, fullText, images }
  }, { mode, /* strip functions */ } as any)

  const lines: string[] = []
  lines.push(`URL: ${url}`)
  if (title) lines.push(`Title: ${title}`)
  lines.push('')

  for (const el of result.interactive) {
    const visible = el.visible !== false
    if (mode === 'compact' && !visible) continue

    const refId = ++state.refCounter
    state.refMap.set(refId, `${el.role}${el.name ? ` "${el.name}"` : ''}`)

    const parts: string[] = ['- ', el.role]
    if (el.name) parts.push(` "${el.name}"`)
    if (el.value && (el.role === 'textbox' || el.role === 'input' || el.role === 'textarea' || el.role === 'searchbox')) {
      parts.push(` value="${el.value}"`)
    }
    if (el.text && !el.name) parts.push(` "${el.text}"`)
    if (el.checked) parts.push(` [${el.checked === 'true' ? 'checked' : el.checked}]`)
    if (el.disabled) parts.push(' [disabled]')
    if (el.selected) parts.push(' [selected]')
    if (!visible) parts.push(' [hidden]')
    parts.push(` [ref=e${refId}]`)

    lines.push(parts.join(''))
  }

  lines.push('')
  lines.push(`--- ${state.refCounter} interactive elements ---`)

  if (mode === 'full' && result.fullText) {
    lines.push('')
    lines.push('## Full page text:')
    lines.push(result.fullText)

    if (result.images.length > 0) {
      lines.push('')
      lines.push(`## ${result.images.length} images:`)
      for (const img of result.images.slice(0, 20)) {
        lines.push(`- ${img.src} (${img.w}x${img.h}${img.alt ? ` "${img.alt}"` : ''})`)
      }
    }
  }

  const text = lines.join('\n')
  state.lastSnapshot = text
  return text
}

/** Read console logs, optionally evaluating a JS expression. */
export async function consoleSnapshot(
  page: Page,
  expression?: string
): Promise<string> {
  const lines: string[] = []

  if (expression) {
    try {
      const result = await page.evaluate(`(function() { return eval(${JSON.stringify(expression)}); })()`)
      lines.push(`## eval: ${expression}`)
      if (result === undefined) {
        lines.push('undefined')
      } else if (result === null) {
        lines.push('null')
      } else if (typeof result === 'object') {
        lines.push(JSON.stringify(result, null, 2))
      } else {
        lines.push(String(result))
      }
    } catch (err) {
      lines.push(`## eval error: ${expression}`)
      lines.push(String(err))
    }
  }

  if (state.consoleLogs.length > 0) {
    lines.push('## console messages (most recent first)')
    const recent = state.consoleLogs.slice(-50).reverse()
    for (const { type, text } of recent) {
      const prefix = { error: '[err]', warning: '[warn]', info: '[info]', log: '[log]' }[type] || `[${type}]`
      lines.push(`${prefix} ${text}`)
    }
  }

  return lines.join('\n') || '(no console output and no expression evaluated)'
}

interface ImageInfo { src: string; alt: string; w: number; h: number }

/** Get all image URLs from the current page. */
export async function imageSnapshot(page: Page): Promise<string> {
  const urls: ImageInfo[] = await page.evaluate(() => {
    const imgs = document.querySelectorAll('img[src]')
    return Array.from(imgs)
      .map((img) => {
        const el = img as HTMLImageElement
        const src = el.src || el.getAttribute('data-src') || ''
        const alt = el.alt || ''
        const w = el.naturalWidth || el.width || 0
        const h = el.naturalHeight || el.height || 0
        return { src, alt, w, h }
      })
      .filter((i) => i.src && (i.src.startsWith('http') || i.src.startsWith('data:')))
  })

  if (urls.length === 0) return 'No images found on the page.'
  const lines = urls.map((i, idx) =>
    `${idx + 1}. ${i.src}\n   size: ${i.w}x${i.h}${i.alt ? ` alt: "${i.alt}"` : ''}`
  )
  return `## ${urls.length} images\n\n${lines.join('\n\n')}`
}

/** Take a viewport screenshot and return it as a base64 JPEG data URL. */
export async function visionScreenshot(page: Page): Promise<{ dataUrl: string; width: number; height: number; format: string }> {
  const buf = await page.screenshot({ type: 'jpeg', quality: 80, fullPage: false })
  const viewport = page.viewportSize() ?? { width: 1280, height: 800 }
  const dataUrl = `data:image/jpeg;base64,${buf.toString('base64')}`
  return { dataUrl, width: viewport.width, height: viewport.height, format: 'jpeg' }
}

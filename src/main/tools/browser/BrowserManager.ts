import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

let _browser: Browser | null = null
let _context: BrowserContext | null = null
let _page: Page | null = null

/** Shared event registry so tools can track per-page state. */
export const state = {
  refCounter: 0,
  refMap: new Map<number, string>(), // refId → element role+name
  lastSnapshot: '',
  consoleLogs: new Array<{ type: string; text: string }>(),
  currentUrl: ''
}

export function resetState(): void {
  state.refCounter = 0
  state.refMap.clear()
  state.lastSnapshot = ''
  state.consoleLogs = []
  state.currentUrl = ''
}

async function ensureBrowser(): Promise<Browser> {
  if (!_browser) {
    _browser = await chromium.launch({ headless: true })
    _context = await _browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'AI-Agent-Studio/1.0 (browser)'
    })
    _page = await _context.newPage()

    // Collect console logs
    _page.on('console', (msg) => {
      state.consoleLogs.push({ type: msg.type(), text: msg.text() })
      if (state.consoleLogs.length > 200) state.consoleLogs.shift()
    })
  }
  return _browser
}

export function getPage(): Page {
  if (!_page) throw new Error('Browser not started — call navigate first.')
  return _page
}

export async function navigate(url: string): Promise<Page> {
  await ensureBrowser()
  resetState()
  const page = getPage()

  // Normalise URL
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20_000 })
  state.currentUrl = page.url()

  return page
}

export async function closeBrowser(): Promise<void> {
  if (_page) { await _page.close().catch(() => {}); _page = null }
  if (_context) { await _context.close().catch(() => {}); _context = null }
  if (_browser) { await _browser.close().catch(() => {}); _browser = null }
}

/** Called on app quit. */
export function disposeBrowser(): void {
  void closeBrowser()
}

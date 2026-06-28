import { app, shell, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc/agent-handlers'
import { configStore } from './config/store'
import { toolRegistry } from './tools/registry'
import { initApprovalsConfig } from './approvals/config'
import { initWorkspaceConfig } from './config/workspaceConfig'
import { startSkillsWatcher, stopSkillsWatcher } from './skills/watcher'
import { loadSnapshot } from './skills/promptBuilder'
import { startScheduler, stopScheduler } from './cron/scheduler'
import { runJob } from './cron/runner'
import { initDb, closeDb } from './db/database'
import { agentStore } from './db/agentStore'
import { disposeBrowser } from './tools/browser/BrowserManager'
// Side-effect: registers all builtin tools (read_file, skill_view, skill_manage).
import './tools/registryBootstrap'

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null

/** Resolve the app icon path (works in both dev and production). */
function iconPath(): string {
  if (is.dev) return join(__dirname, '../../src/public/icon/ai.ico')
  // In production the icon lives in resources/icon/ via electron-builder extraResources
  return join(process.resourcesPath!, 'icon/ai.ico')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    title: 'AI Agent Studio',
    icon: iconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())

  // Close → hide instead of quit (tray keeps the app alive)
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function createTray(): void {
  // Use a small 16x16 version derived from the main icon
  const img = nativeImage.createFromPath(iconPath())
  tray = new Tray(img.resize({ width: 16, height: 16 }))
  tray.setToolTip('AI Agent Studio')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '显示窗口',
      click: () => mainWindow?.show()
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)

  // Double-click tray icon to show the window
  tray.on('double-click', () => mainWindow?.show())
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.aiagentstudio.app')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))

  configStore.init()
  await initDb()
  agentStore.getDefault() // ensure at least one agent exists
  initApprovalsConfig()
  initWorkspaceConfig()
  loadSnapshot()
  void toolRegistry.mcp.loadAndConnectAll()
  startSkillsWatcher()
  startScheduler(runJob)
  registerIpcHandlers(() => mainWindow?.webContents ?? null)

  createWindow()
  createTray()

  app.on('activate', () => {
    // macOS dock click or tray activation — show the existing window
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow?.show()
  })
})

// Don't quit when all windows are closed — the tray keeps the app alive
app.on('window-all-closed', () => {
  // Do NOT quit — on Windows/Linux the tray icon keeps us running
})

app.on('before-quit', () => {
  app.isQuitting = true
  stopSkillsWatcher()
  stopScheduler()
  disposeBrowser()
  closeDb()
  if (tray) tray.destroy()
  tray = null
})

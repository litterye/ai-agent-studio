import { ipcMain, app, dialog, shell, type WebContents } from 'electron'
import { randomUUID } from 'crypto'
import { join, extname, basename } from 'path'
import { statSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { IPC } from '@shared/ipc'
import type {
  AgentDTO,
  AgentEvent,
  AgentSendRequest,
  AppSettings,
  ApprovalsConfigDTO,
  AttachmentMeta,
  CronJobDTO,
  CronStatusDTO,
  McpServerConfigDTO,
  MessageDTO,
  ModelConfigDTO,
  ProviderSettings,
  SessionDTO,
  ToolConfirmResponse,
  WorkspaceConfig
} from '@shared/ipc'
import { agentService } from '../agent/AgentService'
import { toolRegistry } from '../tools/registry'
import { configStore } from '../config/store'
import {
  getApprovalsConfig,
  setToolOverride,
  updateApprovals
} from '../approvals/config'
import {
  getWorkspaceConfig,
  setDefaultCwd,
  setSessionCwd,
  clearSessionCwd
} from '../config/workspaceConfig'
import { localBackend } from '../workspace/localBackend'
import { jobStore } from '../cron/store'
import { getStatus } from '../cron/scheduler'
import { runJob } from '../cron/runner'
import { scanSkills, readSkill } from '../skills/scanner'
import {
  isSkillWorthy,
  generateSkillDraft,
  stagePendingSkill,
  listPendingSkills,
  approvePendingSkill,
  rejectPendingSkill,
  updatePendingSkillMeta
} from '../skills/selfImprove'
import { agentStore } from '../db/agentStore'
import { sessionStore } from '../db/sessionStore'
import { messageStore } from '../db/messageStore'
import { modelStore } from '../db/modelStore'
import { paths } from '../approvals/paths'
import { loadSoul, saveSoul, getDefaultSoul } from '../identity/soul'
import { memoryService } from '../memory/MemoryService'

interface PendingConfirm {
  resolve: (res: { approved: boolean; sessionAlways?: boolean }) => void
}

/** Tracks in-flight runs so they can be cancelled. */
const cancelledRuns = new Set<string>()
/** Pending tool-confirmation promises keyed by confirmId. */
const pendingConfirms = new Map<string, PendingConfirm>()

export function registerIpcHandlers(getSender: () => WebContents | null): void {
  const emit = (event: AgentEvent): void => {
    getSender()?.send(IPC.AgentEvent, event)
  }

  ipcMain.on(IPC.AgentSend, (_e, req: AgentSendRequest) => {
    cancelledRuns.delete(req.runId)
    // Look up session overrides from DB
    let overrides: { model?: string; protocol?: string; effort?: string; baseUrl?: string; visionMode?: string } | undefined
    if (req.sessionId) {
      const session = sessionStore.getById(req.sessionId)
      if (session) {
        overrides = {
          model: session.model,
          protocol: session.protocol,
          effort: session.effort,
          baseUrl: session.base_url || undefined
        }
        // Resolve vision mode: request override > model config > default 'text'
        if (req.visionMode) {
          overrides.visionMode = req.visionMode
        } else {
          const model = modelStore.getByModelId(session.model)
          overrides.visionMode = model?.vision_mode || 'text'
        }
      }
    }
    void agentService.run(
      req.runId,
      req.messages,
      {
        emit,
        isCancelled: () => cancelledRuns.has(req.runId),
        confirm: (toolName, input, reason) =>
          new Promise<{ approved: boolean; sessionAlways?: boolean }>((resolve) => {
            const confirmId = randomUUID()
            pendingConfirms.set(confirmId, { resolve })
            getSender()?.send(IPC.ToolConfirmRequest, {
              runId: req.runId,
              confirmId,
              toolName,
              input,
              reason: reason ?? null
            })
          })
      },
      req.sessionKey ?? null,
      req.sessionId ?? null,
      overrides
    )
  })

  ipcMain.on(IPC.AgentCancel, (_e, runId: string) => {
    cancelledRuns.add(runId)
  })

  ipcMain.on(IPC.ToolConfirmResponse, (_e, res: ToolConfirmResponse) => {
    const pending = pendingConfirms.get(res.confirmId)
    if (!pending) return
    pendingConfirms.delete(res.confirmId)
    if (res.sessionAlways && res.toolName) {
      setToolOverride(res.toolName, 'always')
    }
    pending.resolve({ approved: res.approved, sessionAlways: res.sessionAlways })
  })

  ipcMain.handle(IPC.ToolsList, () => toolRegistry.list())

  ipcMain.handle(IPC.SettingsGet, () => configStore.getSettings())
  ipcMain.handle(IPC.SettingsSet, (_e, next: Partial<ProviderSettings>) =>
    configStore.setSettings(next)
  )

  ipcMain.handle(IPC.KeyStatus, () => configStore.keyStatus())
  ipcMain.handle(IPC.KeySet, (_e, key: string) => configStore.setKey(key))

  ipcMain.handle(IPC.ApprovalsGet, (): ApprovalsConfigDTO => getApprovalsConfig())
  ipcMain.handle(IPC.ApprovalsSet, (_e, partial: Partial<ApprovalsConfigDTO>) =>
    updateApprovals(partial)
  )
  ipcMain.handle(
    IPC.ApprovalsSetToolOverride,
    (_e, args: { toolName: string; value: 'always' | 'never' | 'ask' }) => {
      setToolOverride(args.toolName, args.value)
      return getApprovalsConfig()
    }
  )

  // ─── Workspace ────────────────────────────────────────────────────────

  ipcMain.handle(IPC.WorkspaceGet, (): WorkspaceConfig => getWorkspaceConfig())

  ipcMain.handle(IPC.WorkspaceSetCwd, (_e, args: { sessionKey?: string; cwd: string }) => {
    if (args.sessionKey) {
      return setSessionCwd(args.sessionKey, args.cwd)
    }
    return setDefaultCwd(args.cwd)
  })

  ipcMain.handle(IPC.WorkspaceClearSession, (_e, sessionKey: string) =>
    clearSessionCwd(sessionKey)
  )

  ipcMain.handle(IPC.WorkspaceList, async (_e, args: { path: string }) => {
    const cwd = resolveCurrentCwd()
    const abs = localBackend.resolvePath(args.path, cwd)
    return localBackend.list(abs)
  })

  ipcMain.handle(IPC.WorkspaceRead, async (_e, args: { path: string }) => {
    const cwd = resolveCurrentCwd()
    const abs = localBackend.resolvePath(args.path, cwd)
    return localBackend.read(abs)
  })

  ipcMain.handle(IPC.WorkspaceWrite, async (_e, args: { path: string; content: string }) => {
    const cwd = resolveCurrentCwd()
    const abs = localBackend.resolvePath(args.path, cwd)
    return localBackend.write(abs, args.content)
  })

  ipcMain.handle(
    IPC.WorkspaceSearch,
    async (_e, args: { path: string; query: string; glob?: string; maxResults?: number }) => {
      const cwd = resolveCurrentCwd()
      const abs = localBackend.resolvePath(args.path, cwd)
      return localBackend.search(abs, args.query, args.glob, args.maxResults ?? 30)
    }
  )

  // ─── Cron ────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.CronList, (): CronJobDTO[] => jobStore.list())

  ipcMain.handle(IPC.CronGet, (_e, id: string): CronJobDTO | undefined =>
    jobStore.get(id)
  )

  ipcMain.handle(
    IPC.CronCreate,
    (_e, raw: {
      id: string; name: string; prompt: string
      scheduleInput: string; enabledToolsets?: string[]; workdir?: string
    }): CronJobDTO | string => jobStore.create(raw)
  )

  ipcMain.handle(
    IPC.CronUpdate,
    (_e, args: { id: string; patch: {
      name?: string; prompt?: string; scheduleInput?: string
      enabledToolsets?: string[]; workdir?: string; paused?: boolean
    } }): CronJobDTO | string => jobStore.update(args.id, args.patch)
  )

  ipcMain.handle(IPC.CronDelete, (_e, id: string): boolean => jobStore.remove(id))

  ipcMain.handle(IPC.CronRunNow, async (_e, id: string) => {
    const result = await runJob(id)
    return result
  })

  ipcMain.handle(IPC.CronStatus, (): CronStatusDTO => {
    const status = getStatus()
    return { ...status, jobs: jobStore.list() }
  })

  // ─── Skills ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SkillsList, () =>
    scanSkills().map((s) => ({
      relativePath: s.relativePath,
      name: s.frontmatter.name,
      description: s.frontmatter.description,
      category: s.category,
      frontmatter: s.frontmatter
    }))
  )

  ipcMain.handle(IPC.SkillsGet, (_e, relativePath: string) => {
    const skill = readSkill(relativePath)
    if (!skill) return null
    return { frontmatter: skill.frontmatter, body: skill.body }
  })

  ipcMain.handle(
    IPC.SkillsOfferFromSession,
    async (_e, args: { messages: Array<{ role: string; text: string; toolErrors: boolean }> }) => {
      if (!isSkillWorthy(args.messages)) return null
      const transcript = args.messages
        .map((m) => `[${m.role}]: ${m.text}`)
        .join('\n\n')
      const draft = await generateSkillDraft(transcript)
      if (!draft) return null
      stagePendingSkill(draft)
      return draft
    }
  )

  ipcMain.handle(IPC.SkillsPendingList, () => listPendingSkills())

  ipcMain.handle(IPC.SkillsPendingUpdateMeta, (_e, args: { id: string; name: string; description: string }): boolean =>
    updatePendingSkillMeta(args.id, args.name, args.description)
  )

  ipcMain.handle(IPC.SkillsPendingReview, (_e, args: { id: string; approve: boolean }) => {
    if (args.approve) {
      const dir = approvePendingSkill(args.id)
      if (!dir) return { ok: false, error: 'Not found or already processed.' }
      return { ok: true, path: dir }
    }
    return { ok: rejectPendingSkill(args.id) }
  })

  // ─── MCP ───────────────────────────────────────────────────────────────

  ipcMain.handle(IPC.McpList, async () => {
    return toolRegistry.mcp.listServers()
  })

  ipcMain.handle(IPC.McpConnect, async (_e, config: McpServerConfigDTO) => {
    await toolRegistry.mcp.connect(config)
    return toolRegistry.mcp.listServers()
  })

  ipcMain.handle(IPC.McpDisconnect, async (_e, name: string) => {
    await toolRegistry.mcp.disconnect(name)
    return toolRegistry.mcp.listServers()
  })

  // ─── Agents ───────────────────────────────────────────────────────────

  ipcMain.handle(IPC.AgentList, (): AgentDTO[] => {
    return agentStore.list().map(a => ({
      ...a,
      workspaceDir: a.workspace_dir,
      defaultModel: a.default_model,
      defaultProtocol: a.default_protocol,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      sessionCount: sessionStore.countByAgent(a.id)
    }))
  })

  ipcMain.handle(IPC.AgentGet, (_e, id: string): AgentDTO | undefined => {
    const a = agentStore.getById(id)
    if (!a) return undefined
    return {
      ...a,
      workspaceDir: a.workspace_dir,
      defaultModel: a.default_model,
      defaultProtocol: a.default_protocol,
      createdAt: a.created_at,
      updatedAt: a.updated_at,
      sessionCount: sessionStore.countByAgent(a.id)
    }
  })

  ipcMain.handle(IPC.AgentCreate, (_e, input: {
    name: string; description?: string; workspaceDir?: string
    defaultModel?: string; defaultProtocol?: string
  }): AgentDTO => {
    const a = agentStore.create(input)
    return { ...a, workspaceDir: a.workspace_dir, defaultModel: a.default_model, defaultProtocol: a.default_protocol, createdAt: a.created_at, updatedAt: a.updated_at, sessionCount: 0 }
  })

  ipcMain.handle(IPC.AgentUpdate, (_e, args: { id: string; patch: {
    name?: string; description?: string; workspaceDir?: string
    defaultModel?: string; defaultProtocol?: string
  } }): AgentDTO | undefined => {
    const a = agentStore.update(args.id, args.patch)
    if (!a) return undefined
    return { ...a, workspaceDir: a.workspace_dir, defaultModel: a.default_model, defaultProtocol: a.default_protocol, createdAt: a.created_at, updatedAt: a.updated_at, sessionCount: sessionStore.countByAgent(a.id) }
  })

  ipcMain.handle(IPC.AgentDelete, (_e, id: string): boolean => agentStore.remove(id))

  // ─── Sessions ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.SessionList, (_e, agentId: string): SessionDTO[] => {
    return sessionStore.listByAgent(agentId).map(s => ({
      id: s.id,
      agentId: s.agent_id,
      title: s.title,
      model: s.model,
      protocol: s.protocol,
      effort: s.effort,
      baseUrl: s.base_url,
      createdAt: s.created_at,
      updatedAt: s.updated_at,
      messageCount: sessionStore.countMessages(s.id)
    }))
  })

  ipcMain.handle(IPC.SessionGet, (_e, id: string): SessionDTO | undefined => {
    const s = sessionStore.getById(id)
    if (!s) return undefined
    return { id: s.id, agentId: s.agent_id, title: s.title, model: s.model, protocol: s.protocol, effort: s.effort, baseUrl: s.base_url, createdAt: s.created_at, updatedAt: s.updated_at, messageCount: sessionStore.countMessages(s.id) }
  })

  ipcMain.handle(IPC.SessionCreate, (_e, input: {
    agentId: string; title?: string; model?: string; protocol?: string; effort?: string; baseUrl?: string
  }): SessionDTO => {
    const s = sessionStore.create(input)
    return { id: s.id, agentId: s.agent_id, title: s.title, model: s.model, protocol: s.protocol, effort: s.effort, baseUrl: s.base_url, createdAt: s.created_at, updatedAt: s.updated_at, messageCount: 0 }
  })

  ipcMain.handle(IPC.SessionUpdate, (_e, args: { id: string; patch: {
    title?: string; model?: string; protocol?: string; effort?: string; baseUrl?: string
  } }): SessionDTO | undefined => {
    const s = sessionStore.update(args.id, args.patch)
    if (!s) return undefined
    return { id: s.id, agentId: s.agent_id, title: s.title, model: s.model, protocol: s.protocol, effort: s.effort, baseUrl: s.base_url, createdAt: s.created_at, updatedAt: s.updated_at, messageCount: sessionStore.countMessages(s.id) }
  })

  ipcMain.handle(IPC.SessionDelete, (_e, id: string): boolean => sessionStore.remove(id))

  // ─── Messages ─────────────────────────────────────────────────────────

  ipcMain.handle(IPC.MessagesLoad, (_e, sessionId: string): MessageDTO[] => {
    return messageStore.listBySession(sessionId).map(m => ({
      id: m.id,
      sessionId: m.session_id,
      role: m.role,
      content: m.content,
      thinking: m.thinking,
      toolCallsJson: m.tool_calls_json,
      attachmentsJson: m.attachments_json,
      usageJson: m.usage_json,
      createdAt: m.created_at
    }))
  })

  ipcMain.handle(IPC.MessageAppend, (_e, msg: {
    sessionId: string; role: 'user' | 'assistant'; content?: string; thinking?: string; toolCallsJson?: string; attachmentsJson?: string; usageJson?: string
  }): MessageDTO => {
    const m = messageStore.append(msg)
    return { id: m.id, sessionId: m.session_id, role: m.role, content: m.content, thinking: m.thinking, toolCallsJson: m.tool_calls_json, attachmentsJson: m.attachments_json, usageJson: m.usage_json, createdAt: m.created_at }
  })

  ipcMain.handle(IPC.MessageUpdate, (_e, args: { id: number; patch: { content?: string; thinking?: string; toolCallsJson?: string; attachmentsJson?: string; usageJson?: string } }) => {
    messageStore.update(args.id, args.patch)
  })

  ipcMain.handle(IPC.MessagesClear, (_e, sessionId: string) => {
    messageStore.clearBySession(sessionId)
  })

  // ─── App Settings ─────────────────────────────────────────────────────

  ipcMain.handle(IPC.AppSettingsGet, (): AppSettings => configStore.getAppSettings())
  ipcMain.handle(IPC.AppSettingsSet, (_e, next: Partial<AppSettings>): AppSettings =>
    configStore.setAppSettings(next)
  )

  ipcMain.handle(IPC.AppGetVersion, (): string => app.getVersion())
  ipcMain.on(IPC.AppQuit, () => {
    app.isQuitting = true
    app.quit()
  })

  // ─── Models ──────────────────────────────────────────────────────────

  ipcMain.handle(IPC.ModelList, (): ModelConfigDTO[] => {
    return modelStore.list().map(r => ({
      id: r.id,
      name: r.name,
      protocol: r.protocol,
      baseUrl: r.base_url,
      modelId: r.model_id,
      hasApiKey: !!r.api_key_encrypted,
      visionMode: (r.vision_mode as 'auto' | 'native' | 'text') || 'text',
      createdAt: r.created_at,
      updatedAt: r.updated_at
    }))
  })

  ipcMain.handle(IPC.ModelCreate, (_e, input: {
    name: string; protocol: 'anthropic' | 'openai'; baseUrl?: string; modelId: string; apiKey?: string; visionMode?: string
  }): ModelConfigDTO => {
    const r = modelStore.create(input)
    return {
      id: r.id, name: r.name, protocol: r.protocol,
      baseUrl: r.base_url, modelId: r.model_id,
      hasApiKey: !!r.api_key_encrypted,
      visionMode: (r.vision_mode as 'auto' | 'native' | 'text') || 'text',
      createdAt: r.created_at, updatedAt: r.updated_at
    }
  })

  ipcMain.handle(IPC.ModelUpdate, (_e, args: {
    id: string; patch: { name?: string; protocol?: 'anthropic' | 'openai'; baseUrl?: string; modelId?: string; apiKey?: string; visionMode?: string }
  }): ModelConfigDTO | undefined => {
    const r = modelStore.update(args.id, args.patch)
    if (!r) return undefined
    return {
      id: r.id, name: r.name, protocol: r.protocol,
      baseUrl: r.base_url, modelId: r.model_id,
      hasApiKey: !!r.api_key_encrypted,
      visionMode: (r.vision_mode as 'auto' | 'native' | 'text') || 'text',
      createdAt: r.created_at, updatedAt: r.updated_at
    }
  })

  ipcMain.handle(IPC.ModelDelete, (_e, id: string): boolean => modelStore.remove(id))

  // ─── Dialog / App utilities ───────────────────────────────────────────

  ipcMain.handle(IPC.DialogOpenDirectory, async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle(IPC.DialogOpenFiles, async (): Promise<AttachmentMeta[]> => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return []

    return result.filePaths.map(p => {
      try {
        const s = statSync(p)
        return {
          name: basename(p),
          path: p,
          mimeType: mimeFromExt(extname(p).toLowerCase()),
          size: s.size
        }
      } catch {
        return { name: basename(p), path: p, mimeType: 'application/octet-stream', size: 0 }
      }
    })
  })

  ipcMain.handle(IPC.ShellOpenPath, async (_e, filePath: string): Promise<string> => {
    const err = await shell.openPath(filePath)
    return err // empty string = success, otherwise error message
  })

  ipcMain.handle(IPC.FileReadAsDataUrl, async (_e, filePath: string): Promise<string | null> => {
    try {
      const buf = readFileSync(filePath)
      const ext = extname(filePath).toLowerCase()
      const mime = mimeFromExt(ext)
      return `data:${mime};base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  })

  ipcMain.handle(IPC.FileSaveClipboard, async (_e, dataUrl: string): Promise<AttachmentMeta | null> => {
    try {
      const matches = dataUrl.match(/^data:(.+?);base64,(.+)$/)
      if (!matches) return null
      const mimeType = matches[1]
      const base64 = matches[2]
      const buf = Buffer.from(base64, 'base64')
      // Derive extension from MIME: image/png → png, text/plain → txt, etc.
      // For generic/unknown types fall back to 'bin'.
      const sub = mimeType.split('/')[1] ?? 'bin'
      const ext = sub.replace(/[^a-z0-9]/gi, '').slice(0, 10) || 'bin'
      const dir = join(paths.home, 'workspace', 'clipboard')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const name = `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
      const filePath = join(dir, name)
      writeFileSync(filePath, buf)
      return { name, path: filePath, mimeType, size: buf.length }
    } catch {
      return null
    }
  })

  // ─── SOUL.md (identity) ───────────────────────────────────────────────

  ipcMain.handle(IPC.SoulGet, (): { content: string; path: string } | null => {
    const content = loadSoul()
    if (!content) return null
    return { content, path: paths.soulMd }
  })

  ipcMain.handle(IPC.SoulSet, (_e, content: string): { ok: boolean } => {
    try {
      saveSoul(content)
      return { ok: true }
    } catch {
      return { ok: false }
    }
  })

  ipcMain.handle(IPC.SoulGetDefault, (): string => getDefaultSoul())

  // ─── Memory (cross-session persistent knowledge) ───────────────────────

  ipcMain.handle(IPC.MemoryList, () => memoryService.getAll())

  ipcMain.handle(IPC.MemoryDelete, (_e, id: string): boolean => memoryService.remove(id))

  ipcMain.handle(IPC.MemoryClear, () => {
    memoryService.clear()
  })

  ipcMain.handle(IPC.AppGetWorkspaceBase, (): string => {
    return join(paths.home, 'workspace')
  })
}

/** Simple extension → MIME type lookup. */
function mimeFromExt(ext: string): string {
  const map: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
    '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
    '.xml': 'application/xml', '.csv': 'text/csv', '.log': 'text/plain',
    '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain',
    '.js': 'text/javascript', '.ts': 'text/typescript',
    '.py': 'text/x-python', '.go': 'text/x-go', '.rs': 'text/x-rust',
    '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++',
    '.h': 'text/x-c', '.hpp': 'text/x-c++',
    '.html': 'text/html', '.css': 'text/css', '.vue': 'text/x-vue',
    '.sh': 'text/x-shellscript', '.bat': 'text/plain',
  }
  return map[ext] ?? 'application/octet-stream'
}

function resolveCurrentCwd(): string {
  const ws = getWorkspaceConfig()
  return ws.defaultCwd || process.cwd()
}
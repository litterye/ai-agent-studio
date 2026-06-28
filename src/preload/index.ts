import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '@shared/ipc'
import type {
  AgentDTO,
  AgentEvent,
  AgentSendRequest,
  AppSettings,
  ApprovalsConfigDTO,
  CronJobDTO,
  CronStatusDTO,
  KeyStatus,
  McpServerConfigDTO,
  McpServerStatusDTO,
  MessageDTO,
  ModelConfigDTO,
  ProviderSettings,
  SessionDTO,
  ToolConfirmRequest,
  ToolConfirmResponse,
  ToolInfo,
  WorkspaceConfig,
  WorkspaceDirEntry,
  WorkspaceReadResult,
  WorkspaceSearchHit
} from '@shared/ipc'

/** Narrow, typed surface exposed to the renderer. No raw ipcRenderer leaks. */
const api = {
  agent: {
    send: (req: AgentSendRequest): void => ipcRenderer.send(IPC.AgentSend, req),
    cancel: (runId: string): void => ipcRenderer.send(IPC.AgentCancel, runId),
    onEvent: (cb: (event: AgentEvent) => void): (() => void) => {
      const listener = (_e: unknown, event: AgentEvent): void => cb(event)
      ipcRenderer.on(IPC.AgentEvent, listener)
      return () => ipcRenderer.removeListener(IPC.AgentEvent, listener)
    }
  },
  tools: {
    list: (): Promise<ToolInfo[]> => ipcRenderer.invoke(IPC.ToolsList),
    onConfirmRequest: (cb: (req: ToolConfirmRequest) => void): (() => void) => {
      const listener = (_e: unknown, req: ToolConfirmRequest): void => cb(req)
      ipcRenderer.on(IPC.ToolConfirmRequest, listener)
      return () => ipcRenderer.removeListener(IPC.ToolConfirmRequest, listener)
    },
    respondConfirm: (res: ToolConfirmResponse): void =>
      ipcRenderer.send(IPC.ToolConfirmResponse, res)
  },
  settings: {
    get: (): Promise<ProviderSettings> => ipcRenderer.invoke(IPC.SettingsGet),
    set: (next: Partial<ProviderSettings>): Promise<ProviderSettings> =>
      ipcRenderer.invoke(IPC.SettingsSet, next)
  },
  key: {
    status: (): Promise<KeyStatus> => ipcRenderer.invoke(IPC.KeyStatus),
    set: (key: string): Promise<KeyStatus> => ipcRenderer.invoke(IPC.KeySet, key)
  },
  approvals: {
    get: (): Promise<ApprovalsConfigDTO> => ipcRenderer.invoke(IPC.ApprovalsGet),
    set: (next: Partial<ApprovalsConfigDTO>): Promise<ApprovalsConfigDTO> =>
      ipcRenderer.invoke(IPC.ApprovalsSet, next),
    setToolOverride: (toolName: string, value: 'always' | 'never' | 'ask'): Promise<ApprovalsConfigDTO> =>
      ipcRenderer.invoke(IPC.ApprovalsSetToolOverride, { toolName, value })
  },
  workspace: {
    get: (): Promise<WorkspaceConfig> => ipcRenderer.invoke(IPC.WorkspaceGet),
    setCwd: (args: { sessionKey?: string; cwd: string }): Promise<WorkspaceConfig> =>
      ipcRenderer.invoke(IPC.WorkspaceSetCwd, args),
    clearSession: (sessionKey: string): Promise<WorkspaceConfig> =>
      ipcRenderer.invoke(IPC.WorkspaceClearSession, sessionKey),
    list: (args: { path: string }): Promise<WorkspaceDirEntry[]> =>
      ipcRenderer.invoke(IPC.WorkspaceList, args),
    read: (args: { path: string }): Promise<WorkspaceReadResult> =>
      ipcRenderer.invoke(IPC.WorkspaceRead, args),
    write: (args: { path: string; content: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.WorkspaceWrite, args),
    search: (args: { path: string; query: string; glob?: string; maxResults?: number }): Promise<WorkspaceSearchHit[]> =>
      ipcRenderer.invoke(IPC.WorkspaceSearch, args)
  },
  cron: {
    list: (): Promise<CronJobDTO[]> => ipcRenderer.invoke(IPC.CronList),
    get: (id: string): Promise<CronJobDTO | undefined> => ipcRenderer.invoke(IPC.CronGet, id),
    create: (raw: {
      id: string; name: string; prompt: string
      scheduleInput: string; enabledToolsets?: string[]; workdir?: string
    }): Promise<CronJobDTO | string> => ipcRenderer.invoke(IPC.CronCreate, raw),
    update: (args: {
      id: string; patch: {
        name?: string; prompt?: string; scheduleInput?: string
        enabledToolsets?: string[]; workdir?: string; paused?: boolean
      }
    }): Promise<CronJobDTO | string> => ipcRenderer.invoke(IPC.CronUpdate, args),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.CronDelete, id),
    runNow: (id: string): Promise<{ output: string; error?: string; consecutiveFailures: number }> =>
      ipcRenderer.invoke(IPC.CronRunNow, id),
    status: (): Promise<CronStatusDTO> => ipcRenderer.invoke(IPC.CronStatus)
  },
  skills: {
    list: (): Promise<Array<{ relativePath: string; name: string; description: string; category: string; frontmatter: unknown }>> =>
      ipcRenderer.invoke(IPC.SkillsList),
    get: (relativePath: string): Promise<{ frontmatter: unknown; body: string } | null> =>
      ipcRenderer.invoke(IPC.SkillsGet, relativePath),
    offerFromSession: (args: { messages: Array<{ role: string; text: string; toolErrors: boolean }> }): Promise<unknown> =>
      ipcRenderer.invoke(IPC.SkillsOfferFromSession, args),
    pendingList: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.SkillsPendingList),
    pendingReview: (args: { id: string; approve: boolean }): Promise<{ ok: boolean; path?: string; error?: string }> =>
      ipcRenderer.invoke(IPC.SkillsPendingReview, args),
    pendingUpdateMeta: (args: { id: string; name: string; description: string }): Promise<boolean> =>
      ipcRenderer.invoke(IPC.SkillsPendingUpdateMeta, args)
  },
  mcp: {
    list: (): Promise<McpServerStatusDTO[]> => ipcRenderer.invoke(IPC.McpList),
    connect: (config: McpServerConfigDTO): Promise<McpServerStatusDTO[]> =>
      ipcRenderer.invoke(IPC.McpConnect, config),
    disconnect: (name: string): Promise<McpServerStatusDTO[]> =>
      ipcRenderer.invoke(IPC.McpDisconnect, name)
  },
  agents: {
    list: (): Promise<AgentDTO[]> => ipcRenderer.invoke(IPC.AgentList),
    get: (id: string): Promise<AgentDTO | undefined> => ipcRenderer.invoke(IPC.AgentGet, id),
    create: (input: { name: string; description?: string; workspaceDir?: string; defaultModel?: string; defaultProtocol?: string }): Promise<AgentDTO> =>
      ipcRenderer.invoke(IPC.AgentCreate, input),
    update: (id: string, patch: { name?: string; description?: string; workspaceDir?: string; defaultModel?: string; defaultProtocol?: string }): Promise<AgentDTO | undefined> =>
      ipcRenderer.invoke(IPC.AgentUpdate, { id, patch }),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.AgentDelete, id)
  },
  sessions: {
    list: (agentId: string): Promise<SessionDTO[]> => ipcRenderer.invoke(IPC.SessionList, agentId),
    get: (id: string): Promise<SessionDTO | undefined> => ipcRenderer.invoke(IPC.SessionGet, id),
    create: (input: { agentId: string; title?: string; model?: string; protocol?: string; effort?: string; baseUrl?: string }): Promise<SessionDTO> =>
      ipcRenderer.invoke(IPC.SessionCreate, input),
    update: (id: string, patch: { title?: string; model?: string; protocol?: string; effort?: string; baseUrl?: string }): Promise<SessionDTO | undefined> =>
      ipcRenderer.invoke(IPC.SessionUpdate, { id, patch }),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.SessionDelete, id)
  },
  messages: {
    load: (sessionId: string): Promise<MessageDTO[]> => ipcRenderer.invoke(IPC.MessagesLoad, sessionId),
    append: (msg: { sessionId: string; role: 'user' | 'assistant'; content?: string; thinking?: string; toolCallsJson?: string; attachmentsJson?: string }): Promise<MessageDTO> =>
      ipcRenderer.invoke(IPC.MessageAppend, msg),
    update: (id: number, patch: { content?: string; thinking?: string; toolCallsJson?: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.MessageUpdate, { id, patch }),
    clear: (sessionId: string): Promise<void> => ipcRenderer.invoke(IPC.MessagesClear, sessionId)
  },
  appSettings: {
    get: (): Promise<AppSettings> => ipcRenderer.invoke(IPC.AppSettingsGet),
    set: (next: Partial<AppSettings>): Promise<AppSettings> => ipcRenderer.invoke(IPC.AppSettingsSet, next)
  },
  app: {
    getVersion: (): Promise<string> => ipcRenderer.invoke(IPC.AppGetVersion),
    quit: (): void => ipcRenderer.send(IPC.AppQuit),
    getWorkspaceBase: (): Promise<string> => ipcRenderer.invoke(IPC.AppGetWorkspaceBase)
  },
  dialog: {
    openDirectory: (): Promise<string | null> => ipcRenderer.invoke(IPC.DialogOpenDirectory),
    openFiles: (): Promise<import('@shared/ipc').AttachmentMeta[]> => ipcRenderer.invoke(IPC.DialogOpenFiles)
  },
  shell: {
    openPath: (path: string): Promise<string> => ipcRenderer.invoke(IPC.ShellOpenPath, path)
  },
  files: {
    readAsDataUrl: (path: string): Promise<string | null> => ipcRenderer.invoke(IPC.FileReadAsDataUrl, path),
    saveClipboard: (dataUrl: string): Promise<import('@shared/ipc').AttachmentMeta | null> => ipcRenderer.invoke(IPC.FileSaveClipboard, dataUrl)
  },
  models: {
    list: (): Promise<ModelConfigDTO[]> => ipcRenderer.invoke(IPC.ModelList),
    create: (input: { name: string; protocol: 'anthropic' | 'openai'; baseUrl?: string; modelId: string; apiKey?: string; visionMode?: string }): Promise<ModelConfigDTO> =>
      ipcRenderer.invoke(IPC.ModelCreate, input),
    update: (id: string, patch: { name?: string; protocol?: 'anthropic' | 'openai'; baseUrl?: string; modelId?: string; apiKey?: string; visionMode?: string }): Promise<ModelConfigDTO | undefined> =>
      ipcRenderer.invoke(IPC.ModelUpdate, { id, patch }),
    delete: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ModelDelete, id)
  }
}

export type AppApi = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (fallback when contextIsolation is off)
  window.electron = electronAPI
  // @ts-ignore
  window.api = api
}

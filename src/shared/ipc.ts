/**
 * Shared types & IPC channel contract.
 * Imported by main, preload and renderer — keep framework-free (no electron/anthropic imports).
 */

/** A content part the renderer knows how to display. */
export type ChatRole = 'user' | 'assistant'

/** Metadata for a file attached to a user message. File data stays on disk. */
export interface AttachmentMeta {
  name: string       // original filename, e.g. "screenshot.png"
  path: string       // absolute path on disk
  mimeType: string   // e.g. "image/png", "text/plain"
  size: number       // bytes
}

/** Minimal message shape exchanged over IPC (renderer -> main). */
export interface ChatMessage {
  role: ChatRole
  /** Plain text content. Tool round-trips are handled inside the main process. */
  content: string
  /** Optional file attachments (images, code, docs). Max 9, ≤200MB each. */
  attachments?: AttachmentMeta[]
}

export type Protocol = 'anthropic' | 'openai'

/**
 * How the agent handles image attachments in chat messages.
 * Mirrors Hermes Agent's `image_input_mode` config.
 *
 * - `auto`:   Detect model vision capability — native pixels if supported, text annotation if not.
 * - `native`: Always send real image blocks (image_url / image source). Non-vision models may error.
 * - `text`:   Always send a text annotation with file metadata (safe, works with any model).
 */
export type VisionMode = 'auto' | 'native' | 'text'

export interface ProviderSettings {
  protocol: Protocol
  /** Custom API base URL. Empty string = use the SDK default for the protocol. */
  baseUrl: string
  /** Model id, free-text (e.g. claude-opus-4-8, gpt-4o, or a local model name). */
  model: string
  /** Anthropic-only reasoning effort; ignored by the OpenAI path. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
}

export interface ToolInfo {
  name: string
  description: string
  /** 'builtin' or the MCP server name it came from. */
  source: string
  needsConfirmation: boolean
  /** Permission bucket — see main/tools/types.ts. */
  toolset: string
  /** Optional emoji for UI rendering. */
  emoji?: string
}

/** Why a tool call needed user confirmation. Mirrors `PolicyReason` in tools/policy.ts. */
export interface PolicyReason {
  rule: 'dangerous-command' | 'smart-approve-deny' | 'write-denylist' | 'default-confirm' | 'toolset-disabled' | 'yolo'
  message: string
  detail?: Record<string, unknown>
}

/** Events streamed from main -> renderer during an agent run. */
export type AgentEvent =
  | { type: 'text_delta'; runId: string; text: string }
  | { type: 'thinking_delta'; runId: string; text: string }
  | { type: 'tool_use'; runId: string; toolName: string; input: unknown; id: string }
  | { type: 'tool_result'; runId: string; toolName: string; id: string; isError: boolean; content: string }
  | { type: 'done'; runId: string; finalText: string }
  | { type: 'error'; runId: string; message: string }
  | { type: 'cancelled'; runId: string }
  /** Per-turn token usage from the model response. Emitted after each API call completes. */
  | { type: 'token_usage'; runId: string; inputTokens: number; outputTokens: number }
  /** Side-channel: the user picked "always this session" on a confirm dialog.
   *  Renderer should persist a tool override and re-fetch approvals config. */
  | { type: 'policy_decision'; runId: string; toolName: string; decision: 'session-always' }

/** Request to run the agent. */
export interface AgentSendRequest {
  runId: string
  messages: ChatMessage[]
  /**
   * Optional conversation id, used to pin a per-session cwd. Omit for
   * anonymous runs (e.g. cron).
   */
  sessionKey?: string
  /** DB session id — when present, the main process loads model/protocol from DB. */
  sessionId?: string
  /** Optional per-request vision mode override. Falls back to model config. */
  visionMode?: VisionMode
}

// ─── Agent / Session / Message DTOs ────────────────────────────────────

export interface AgentDTO {
  id: string
  name: string
  description: string
  workspaceDir: string
  defaultModel: string
  defaultProtocol: string
  createdAt: string
  updatedAt: string
  sessionCount: number
}

export interface SessionDTO {
  id: string
  agentId: string
  title: string
  model: string
  protocol: string
  effort: string
  baseUrl: string
  createdAt: string
  updatedAt: string
  messageCount: number
}

export interface MessageDTO {
  id: number
  sessionId: string
  role: 'user' | 'assistant'
  content: string
  thinking: string
  toolCallsJson: string
  attachmentsJson: string
  usageJson: string
  createdAt: string
}

/** Tool confirmation round-trip (main asks renderer). */
export interface ToolConfirmRequest {
  runId: string
  confirmId: string
  toolName: string
  input: unknown
  /** When present, the renderer should render a "policy: <reason>" banner. */
  reason?: PolicyReason | null
}

export interface ToolConfirmResponse {
  confirmId: string
  approved: boolean
  /** True if the user picked "always this session" — main process persists a tool override. */
  sessionAlways?: boolean
  /** Echoed from the request — main process needs this to write the override. */
  toolName?: string
}

/** API-key status (never sends the key itself to the renderer). Reflects the active protocol. */
export interface KeyStatus {
  hasKey: boolean
  source: 'env' | 'stored' | 'none'
}

/** Shape of ~/.ai-agent-studio/config/approvals.yaml */
export interface ApprovalsConfigDTO {
  yoloMode: boolean
  cronMode: 'silent' | 'notify'
  smartApprove: boolean
  memory: { writeApproval: boolean }
  skills: { writeApproval: boolean }
  toolsets: {
    default: string[]
    confirmOverride: Record<string, 'always' | 'never' | 'ask'>
  }
}

/** Workspace — read result mirrored from main/workspace/fileOps.ts */
export interface WorkspaceReadResult {
  content: string
  totalLines: number
  fileSize: number
  truncated: boolean
  isBinary: boolean
  error?: string
}

export interface WorkspaceDirEntry {
  name: string
  kind: 'file' | 'dir'
  size: number
  modifiedMs: number
}

export interface WorkspaceSearchHit {
  path: string
  line: number
  column: number
  lineContent: string
  match: string
}

export interface WorkspaceConfig {
  defaultCwd: string
  sessions: Record<string, string>
}

/** Cron — job shape for renderer (subset of main cron types). */
export interface CronJobDTO {
  id: string
  name: string
  prompt: string
  schedule: { kind: 'cron' | 'interval' | 'once'; expr?: string; minutes?: number; runAt?: string }
  enabledToolsets?: string[]
  workdir?: string
  /** Agent ID this job is associated with. */
  agentId?: string
  /** Target session ID. If set, messages are appended to this existing session. */
  sessionId?: string
  /** Resolved display title for the target session (set by IPC handler). */
  sessionTitle?: string
  lastRunAt: string | null
  lastResult: string | null
  nextRunAt: string | null
  consecutiveFailures: number
  paused: boolean
  createdAt: string
}

/** MCP server configuration (mirrors main McpServerConfig). */
export interface McpServerConfigDTO {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpServerStatusDTO {
  name: string
  connected: boolean
  toolCount: number
  config: McpServerConfigDTO
}

export interface CronStatusDTO {
  tickerHeartbeat: string | null
  tickerLastSuccess: string | null
  running: boolean
  jobs: CronJobDTO[]
}

/** App-level settings (theme, language, etc.) — separate from provider config. */
export interface AppSettings {
  theme: 'light' | 'dark' | 'eye-care'
  language: 'zh-CN'
  /** Last active agent ID restored on next launch. */
  lastAgentId?: string
  /** Last active session ID restored on next launch. */
  lastSessionId?: string
}

/** A saved model configuration that can be selected by agents/sessions. */
export interface ModelConfigDTO {
  id: string
  name: string
  protocol: 'anthropic' | 'openai'
  baseUrl: string
  modelId: string
  /** Whether an API key has been stored for this model (key itself never leaves main). */
  hasApiKey: boolean
  /** Image handling mode: auto/native/text. Defaults to 'text' (safest). */
  visionMode: VisionMode
  createdAt: string
  updatedAt: string
}

/** A single memory entry — cross-session persistent knowledge. */
export interface MemoryEntryDTO {
  id: string
  type: 'fact' | 'preference' | 'feedback' | 'learning'
  content: string
  keywords: string
  importance: number
  sourceSessionId: string
  accessCount: number
  lastAccessedAt: string | null
  createdAt: string
  updatedAt: string
}

/** Memory-related events from main -> renderer. */
export interface MemoryEvent {
  /** Model API error (rate limit, auth failure, network issues, etc.) */
  type: 'model_error'
  message: string
  /** Human-readable translated message */
  displayMessage: string
  /** The model that failed */
  model?: string
  /** Timestamp for display */
  timestamp: string
}

export const IPC = {
  AgentSend: 'agent:send',
  AgentCancel: 'agent:cancel',
  AgentEvent: 'agent:event',
  ToolConfirmRequest: 'tool:confirm-request',
  ToolConfirmResponse: 'tool:confirm-response',
  ToolsList: 'tools:list',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  KeyStatus: 'key:status',
  KeySet: 'key:set',
  ApprovalsGet: 'approvals:get',
  ApprovalsSet: 'approvals:set',
  ApprovalsSetToolOverride: 'approvals:set-tool-override',
  WorkspaceGet: 'workspace:get',
  WorkspaceSetCwd: 'workspace:set-cwd',
  WorkspaceClearSession: 'workspace:clear-session',
  WorkspaceList: 'workspace:list',
  WorkspaceRead: 'workspace:read',
  WorkspaceWrite: 'workspace:write',
  WorkspaceSearch: 'workspace:search',
  CronList: 'cron:list',
  CronGet: 'cron:get',
  CronCreate: 'cron:create',
  CronUpdate: 'cron:update',
  CronDelete: 'cron:delete',
  CronRunNow: 'cron:run-now',
  CronRunHistory: 'cron:run-history',
  CronStatus: 'cron:status',
  CronEvent: 'cron:event',
  SkillsList: 'skills:list',
  SkillsGet: 'skills:get',
  SkillsOfferFromSession: 'skills:offer-from-session',
  SkillsPendingList: 'skills:pending-list',
  SkillsPendingReview: 'skills:pending-review',
  SkillsPendingUpdateMeta: 'skills:pending-update-meta',
  McpList: 'mcp:list',
  McpConnect: 'mcp:connect',
  McpDisconnect: 'mcp:disconnect',
  AgentList: 'agent:list',
  AgentGet: 'agent:get',
  AgentCreate: 'agent:create',
  AgentUpdate: 'agent:update',
  AgentDelete: 'agent:delete',
  SessionList: 'session:list',
  SessionGet: 'session:get',
  SessionCreate: 'session:create',
  SessionUpdate: 'session:update',
  SessionDelete: 'session:delete',
  MessagesLoad: 'messages:load',
  MessageAppend: 'message:append',
  MessageUpdate: 'message:update',
  MessagesClear: 'messages:clear',
  AppSettingsGet: 'app-settings:get',
  AppSettingsSet: 'app-settings:set',
  AppGetVersion: 'app:get-version',
  AppQuit: 'app:quit',
  ModelList: 'model:list',
  ModelCreate: 'model:create',
  ModelUpdate: 'model:update',
  ModelDelete: 'model:delete',
  DialogOpenDirectory: 'dialog:open-directory',
  DialogOpenFiles: 'dialog:open-files',
  ShellOpenPath: 'shell:open-path',
  ShellOpenExternal: 'shell:open-external',
  FileReadAsDataUrl: 'file:read-as-data-url',
  FileSaveClipboard: 'file:save-clipboard',
  SoulGet: 'soul:get',
  SoulSet: 'soul:set',
  SoulGetDefault: 'soul:get-default',
  AppGetWorkspaceBase: 'app:get-workspace-base',
  MemoryList: 'memory:list',
  MemoryDelete: 'memory:delete',
  MemoryClear: 'memory:clear',
  MemoryError: 'memory:error'
} as const
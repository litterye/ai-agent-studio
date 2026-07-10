import type { z } from 'zod'

/**
 * Per-invocation context passed to tool handlers.
 * Set by the agent loop before each tool.run() and cleared after.
 * Tools read this instead of relying on environment variables.
 */
export interface ToolRunContext {
  cwd: string
  sessionId?: string | null
  activeToolsets?: Set<string>
}

let _currentToolCtx: ToolRunContext | null = null

/** Set the context for the current tool invocation. Called by the agent loop. */
export function setToolRunContext(ctx: ToolRunContext | null): void {
  _currentToolCtx = ctx
}

/** Read the context of the current tool invocation. Tools call this in their handler. */
export function getToolRunContext(): ToolRunContext {
  if (!_currentToolCtx) {
    return { cwd: process.cwd() }
  }
  return _currentToolCtx
}

/** JSON Schema object passed to the Anthropic SDK as input_schema. */
export interface JsonSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

/**
 * A named bucket of tools used for permissioning. Mirrors Hermes's `toolset`
 * concept. Examples: 'file', 'terminal', 'skills', 'memory', 'mcp', 'web'.
 */
export type Toolset = string

/** A tool the agent can call. Built-ins and MCP tools both implement this. */
export interface AgentTool {
  name: string
  description: string
  inputSchema: JsonSchema
  /** Where it came from: 'builtin' or the MCP server name. */
  source: string
  /** Toolset this tool belongs to — drives permission policy. */
  toolset: Toolset
  /** Gate execution behind a user confirmation dialog by default. Policy may override. */
  needsConfirmation: boolean
  /** Optional emoji for UI rendering. */
  emoji?: string
  /** Max characters in the run() return value; loop truncates beyond this. */
  maxResultSizeChars?: number
  /** Execute the tool. Throw on failure; the loop converts it to an is_error result. */
  run(input: unknown): Promise<string>
}

/** Helper to build a builtin tool from a zod schema. */
export interface BuiltinToolDef<T> {
  name: string
  description: string
  schema: z.ZodType<T>
  jsonSchema: JsonSchema
  toolset: Toolset
  needsConfirmation?: boolean
  emoji?: string
  maxResultSizeChars?: number
  handler(input: T): Promise<string>
}

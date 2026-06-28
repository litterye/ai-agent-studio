import type { z } from 'zod'

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

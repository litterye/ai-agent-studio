import type { AgentTool, Toolset } from './types'
import type { ToolInfo } from '@shared/ipc'
import { createReadFileTool } from './builtin/readFile'
import { McpManager } from './mcp/McpManager'

/**
 * Aggregates builtin tools + MCP tools and produces the merged tool list
 * the agent loop hands to the Anthropic SDK each turn.
 *
 * v2: supports toolset-based permissioning. Builtins are registered via the
 * `register()` API (called from registryBootstrap.ts); MCP tools are wrapped
 * with their server's name as the toolset.
 */
export class ToolRegistry {
  private tools = new Map<string, AgentTool>()
  readonly mcp = new McpManager()

  constructor() {
    // Bootstrap with the always-available read_file so existing flows work
    // even if the bootstrap module hasn't run yet. The bootstrap will
    // re-register the same tool — register() refuses duplicates from the
    // same toolset so this is a no-op.
    this.register(createReadFileTool())
  }

  /**
   * Add a tool. Refuses to register a name that already exists in the same
   * toolset — call `registerOverride()` to replace.
   */
  register(tool: AgentTool): void {
    const existing = this.tools.get(tool.name)
    if (existing && existing.toolset === tool.toolset) {
      // Idempotent: same toolset re-registration is a no-op.
      return
    }
    if (existing && existing.toolset !== tool.toolset) {
      throw new Error(
        `Tool "${tool.name}" already registered to toolset "${existing.toolset}"; ` +
          `cannot add to "${tool.toolset}" without override=true.`
      )
    }
    this.tools.set(tool.name, tool)
  }

  /** Force-register a tool, replacing any existing entry. */
  registerOverride(tool: AgentTool): void {
    this.tools.set(tool.name, tool)
  }

  /** All currently available tools (builtins + connected MCP servers). */
  async all(): Promise<AgentTool[]> {
    const mcpTools = await this.mcp.listTools()
    return [...this.tools.values(), ...mcpTools]
  }

  /**
   * Tools available in a given session — filtered by the active toolsets.
   * If `activeToolsets` is null/empty, all tools are returned (legacy behavior).
   */
  async forSession(activeToolsets: Set<Toolset> | null): Promise<AgentTool[]> {
    const all = await this.all()
    if (!activeToolsets || activeToolsets.size === 0) return all
    return all.filter((t) => activeToolsets.has(t.toolset))
  }

  async find(name: string): Promise<AgentTool | undefined> {
    return (await this.all()).find((t) => t.name === name)
  }

  /** Lightweight info for the renderer's tools view. */
  async list(): Promise<ToolInfo[]> {
    const extended: ToolInfo[] = (await this.all()).map((t) => ({
      name: t.name,
      description: t.description,
      source: t.source,
      needsConfirmation: t.needsConfirmation,
      toolset: t.toolset,
      emoji: t.emoji
    }))
    return extended
  }
}

export const toolRegistry = new ToolRegistry()

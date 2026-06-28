import { readFileSync, writeFileSync, existsSync } from 'fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { AgentTool, JsonSchema } from '../types'
import type { McpServerStatusDTO } from '@shared/ipc'
import { paths, ensureDir } from '../../approvals/paths'

export interface McpServerConfig {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

interface Connection {
  config: McpServerConfig
  client: Client
}

/**
 * Manages connections to stdio MCP servers and proxies their tools
 * into the AgentTool interface so the registry can merge them with builtins.
 *
 * Configs are persisted to ~/.ai-agent-studio/config/mcp-servers.json.
 */
export class McpManager {
  private connections = new Map<string, Connection>()

  /** Load saved configs from disk and connect to all of them. */
  async loadAndConnectAll(): Promise<void> {
    const configs = this.loadConfigs()
    for (const cfg of configs) {
      try {
        await this.connect(cfg)
      } catch (err) {
        console.error(`[mcp] failed to connect to "${cfg.name}":`, err)
      }
    }
  }

  /** Read persisted server configs from disk. */
  loadConfigs(): McpServerConfig[] {
    if (!existsSync(paths.mcpServersConfig)) return []
    try {
      const raw = readFileSync(paths.mcpServersConfig, 'utf8')
      return JSON.parse(raw) as McpServerConfig[]
    } catch {
      return []
    }
  }

  /** Write current connection configs to disk. */
  private saveConfigs(): void {
    ensureDir(paths.configDir)
    const configs: McpServerConfig[] = []
    for (const [, conn] of this.connections) {
      configs.push({ ...conn.config })
    }
    writeFileSync(paths.mcpServersConfig, JSON.stringify(configs, null, 2), 'utf8')
  }

  async connect(config: McpServerConfig): Promise<void> {
    if (this.connections.has(config.name)) {
      await this.disconnect(config.name)
    }
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(config.env ?? {}) }
    })
    const client = new Client({ name: 'ai-agent-studio', version: '0.1.0' }, { capabilities: {} })
    await client.connect(transport)
    this.connections.set(config.name, { config, client })
    this.saveConfigs()
  }

  async disconnect(name: string): Promise<void> {
    const conn = this.connections.get(name)
    if (!conn) return
    try {
      await conn.client.close()
    } catch {
      /* ignore */
    }
    this.connections.delete(name)
    this.saveConfigs()
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((n) => this.disconnect(n)))
  }

  /** Connection status for the renderer. */
  async listServers(): Promise<McpServerStatusDTO[]> {
    const results: McpServerStatusDTO[] = []
    for (const [, conn] of this.connections) {
      let toolCount = 0
      try {
        const res = await conn.client.listTools()
        toolCount = res.tools.length
      } catch { /* server might be unhealthy */ }
      results.push({
        name: conn.config.name,
        connected: true,
        toolCount,
        config: { ...conn.config }
      })
    }
    return results
  }

  /** List all tools across connected servers, wrapped as AgentTool. MCP tools default to needing confirmation. */
  async listTools(): Promise<AgentTool[]> {
    const out: AgentTool[] = []
    for (const [serverName, conn] of this.connections) {
      let tools
      try {
        const res = await conn.client.listTools()
        tools = res.tools
      } catch {
        continue
      }
      for (const t of tools) {
        const inputSchema = normalizeSchema(t.inputSchema)
        out.push({
          name: `${serverName}__${t.name}`,
          description: t.description ?? `MCP tool ${t.name} from ${serverName}`,
          inputSchema,
          source: serverName,
          toolset: 'mcp',
          needsConfirmation: true,
          run: async (input: unknown): Promise<string> => {
            const result = await conn.client.callTool({
              name: t.name,
              arguments: (input ?? {}) as Record<string, unknown>
            })
            return stringifyMcpResult(result)
          }
        })
      }
    }
    return out
  }
}

/** Coerce an MCP tool's JSON-Schema input into the object shape the SDK expects. */
function normalizeSchema(schema: unknown): JsonSchema {
  const s = (schema ?? {}) as Record<string, unknown>
  return {
    type: 'object',
    properties: (s.properties as Record<string, unknown>) ?? {},
    required: (s.required as string[]) ?? [],
    additionalProperties: false
  }
}

function stringifyMcpResult(result: unknown): string {
  const r = result as { content?: Array<{ type: string; text?: string }> }
  if (Array.isArray(r.content)) {
    return r.content
      .map((c) => (c.type === 'text' && c.text ? c.text : JSON.stringify(c)))
      .join('\n')
  }
  return JSON.stringify(result)
}

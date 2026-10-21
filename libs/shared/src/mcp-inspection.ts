import { isMcpExposure, type McpExposure, type McpServerState } from './mcp'

export const MCP_INSPECTION_STATUS_KEY = 'mcp-inspection'

/** Display-only metadata. Credentials and resolved configuration never enter this contract. */
export interface McpToolDetail {
  name: string
  description?: string
  exposure: McpExposure
}

export interface McpInspection {
  name: string
  state: McpServerState
  tools: McpToolDetail[]
  error?: string
}

export interface McpCheckSnapshot {
  checkedAt: number
  report: McpInspection
  /** Last successful discovery; kept when a subsequent probe fails. */
  discoveredAt?: number
  tools: McpToolDetail[]
}

export type McpLaneResult =
  { ok: true; report: McpInspection; inspectedAt: number } | { ok: false; message: string }

export type McpCheckResult =
  { ok: true; snapshot: McpCheckSnapshot } | { ok: false; message: string; unsupported?: boolean }

const STATES = new Set<string>([
  'connected',
  'needs-auth',
  'failed',
  'disconnected',
  'connecting',
  'closed',
  'disabled',
])

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Versioned native pi report, treated as untrusted subprocess output. */
export function parseMcpInspection(value: unknown, name: string): McpInspection | null {
  if (!record(value) || value.version !== 1 || !record(value.server)) return null
  const server = value.server
  const state = server.state === 'starting' ? 'connecting' : server.state
  if (server.name !== name || typeof state !== 'string' || !STATES.has(state)) return null
  if (!Array.isArray(server.tools) || server.tools.length > 2000) return null
  const tools: McpToolDetail[] = []
  const names = new Set<string>()
  for (const tool of server.tools) {
    if (
      !record(tool) ||
      typeof tool.name !== 'string' ||
      !tool.name ||
      tool.name.length > 256 ||
      !isMcpExposure(tool.exposure) ||
      names.has(tool.name)
    )
      return null
    names.add(tool.name)
    tools.push({
      name: tool.name,
      exposure: tool.exposure,
      ...(typeof tool.description === 'string'
        ? { description: tool.description.slice(0, 8000) }
        : {}),
    })
  }
  return {
    name,
    state: state as McpServerState,
    tools,
    ...(typeof server.error === 'string'
      ? { error: server.error.slice(0, 2000) }
      : record(server.error) && typeof server.error.message === 'string'
        ? { error: server.error.message.slice(0, 2000) }
        : {}),
  }
}

import { app } from 'electron'
import { join } from 'node:path'
import type { McpCheckResult, McpCheckSnapshot } from '@shared/mcp-inspection'
import {
  McpInspectionCache,
  inspectionKey,
} from '@phosphor/session-runtime/pi/mcp-inspection-cache'
import { McpInspector } from '@phosphor/session-runtime/pi/mcp-inspection'
import { readMcpConfigs } from './mcp-config'
import { piCli } from './mcp-actions'
import { disposeMcpLogins } from './mcp-cli'

const inspector = new McpInspector()
const requests = new Map<string, AbortController>()
let cache: McpInspectionCache | undefined
function metadata(): McpInspectionCache {
  // Lazy: E2E redirects userData before any persistence is opened.
  return (cache ??= new McpInspectionCache(join(app.getPath('userData'), 'mcp-inspections.json')))
}
function context(workspacePath?: string): string {
  return workspacePath ?? ''
}

export async function readMcpChecks(
  workspacePath?: string,
): Promise<Record<string, McpCheckSnapshot>> {
  const configs = await readMcpConfigs(workspacePath)
  const entries = await Promise.all(
    configs.servers.map(async (server) => {
      const result = await metadata().get(inspectionKey(context(workspacePath), server))
      return result ? ([server.name, result] as const) : null
    }),
  )
  return Object.fromEntries(entries.filter((entry) => entry !== null))
}

export async function checkMcpServer(
  owner: number,
  name: string,
  workspacePath: string | undefined,
  requestId: string,
): Promise<McpCheckResult> {
  if (!/^[\w-]{1,80}$/.test(requestId)) throw new Error('Invalid check request.')
  const id = `${owner}:${requestId}`
  if (requests.has(id)) throw new Error('Check already running.')
  if (requests.size >= 128) return { ok: false, message: 'Too many connector checks.' }
  const abort = new AbortController()
  requests.set(id, abort)
  try {
    return await runCheck(name, workspacePath, abort.signal)
  } finally {
    requests.delete(id)
  }
}

async function runCheck(
  name: string,
  workspacePath: string | undefined,
  signal: AbortSignal,
): Promise<McpCheckResult> {
  const configs = await readMcpConfigs(workspacePath)
  if (configs.legacy)
    return { ok: false, message: 'Migrate the MCP adapter before testing native connectors.' }
  const server = configs.servers.find((item) => item.name === name)
  if (!server) return { ok: false, message: 'Connector no longer exists in this workspace.' }
  const key = inspectionKey(context(workspacePath), server)
  const cli = await piCli(workspacePath)
  if (!cli) return { ok: false, message: 'Pi is not available.' }
  const result = await inspector.check({ ...cli, env: cli.env ?? {} }, name, signal)
  if (!result.ok) return result
  if (signal.aborted) return { ok: false, message: 'Check cancelled.' }
  const after = (await readMcpConfigs(workspacePath)).servers.find((item) => item.name === name)
  if (!after || inspectionKey(context(workspacePath), after) !== key)
    return { ok: false, message: 'Connector configuration changed during the check. Test again.' }
  return { ok: true, snapshot: await metadata().put(key, result.report) }
}

export function cancelMcpCheck(owner: number, requestId: string): void {
  requests.get(`${owner}:${requestId}`)?.abort()
}
export function cancelOwnerChecks(owner: number): void {
  for (const [id, controller] of requests) if (id.startsWith(`${owner}:`)) controller.abort()
}
export function disposeMcpConnections(force = false): Promise<void> {
  disposeMcpLogins()
  for (const controller of requests.values()) controller.abort()
  return inspector.dispose(force)
}

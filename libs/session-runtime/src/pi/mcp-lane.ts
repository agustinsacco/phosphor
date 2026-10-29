import { randomBytes } from 'node:crypto'
import { MCP_SERVER_NAME } from '@phosphor/shared/mcp'
import {
  MCP_INSPECTION_STATUS_KEY,
  parseMcpInspection,
  type McpLaneResult,
} from '@phosphor/shared/mcp-inspection'
import type { ExtensionUIRequest } from '@phosphor/shared/rpc'
import type { PiRpcClient } from './rpc-client'

type Client = Pick<PiRpcClient, 'request' | 'on' | 'off'>

/** Native extension machine command, never model text. Capability is checked before dispatch. */
export async function controlMcpInLane(
  client: Client,
  name: string,
  operation: 'inspect' | 'reconnect',
): Promise<McpLaneResult> {
  if (!MCP_SERVER_NAME.test(name) || !['inspect', 'reconnect'].includes(operation))
    return { ok: false, message: 'Invalid connector operation.' }
  try {
    const commands = await client.request({ type: 'get_commands' })
    if (
      !commands.success ||
      !commands.data?.commands.some(
        (command) =>
          command.name === 'mcp' &&
          command.source === 'extension' &&
          command.sourceInfo?.path === 'builtin:mcp' &&
          command.sourceInfo.source === 'builtin' &&
          command.description?.includes('[inspection-v1]'),
      )
    )
      return {
        ok: false,
        unsupported: true,
        message:
          'This lane’s pi does not support native MCP inspection. Upgrade pi and start a new lane.',
      }
    if (operation === 'reconnect') {
      const state = await client.request({ type: 'get_state' })
      if (!state.success || !state.data || state.data.isStreaming || state.data.isCompacting)
        return {
          ok: false,
          message: 'This lane is busy. Reconnect after its current turn finishes.',
        }
    }
    const result = await send(client, name, operation)
    // A host-control prompt still marks SessionActivity unsettled. Reconcile
    // against native state so inspection cannot leave an idle lane falsely busy.
    await client.request({ type: 'get_state' })
    return result
  } catch {
    return {
      ok: false,
      message: 'Could not inspect this lane’s connector. The lane may have closed.',
    }
  }
}

async function send(
  client: Client,
  name: string,
  operation: 'inspect' | 'reconnect',
): Promise<McpLaneResult> {
  const requestId = randomBytes(16).toString('hex')
  let result: McpLaneResult = {
    ok: false,
    message: 'Native pi did not confirm the connector operation.',
  }
  const onStatus = (request: ExtensionUIRequest) => {
    if (
      request.method !== 'setStatus' ||
      request.statusKey !== MCP_INSPECTION_STATUS_KEY ||
      !request.statusText ||
      request.statusText.length > 2 * 1024 * 1024
    )
      return
    try {
      const value = JSON.parse(request.statusText) as {
        version?: unknown
        requestId?: unknown
        operation?: unknown
        server?: unknown
      }
      if (value.requestId !== requestId || value.operation !== operation) return
      const report = parseMcpInspection(value, name)
      if (report) result = { ok: true, report, inspectedAt: Date.now() }
    } catch {
      /* Ignore unrelated or malformed extension status. */
    }
  }
  client.on('extension-ui', onStatus)
  try {
    const response = await client.request({
      type: 'prompt',
      message: `/mcp ${operation} ${name} --json --request ${requestId}`,
    })
    if (!response.success)
      return { ok: false, message: 'Native pi refused the connector operation.' }
    return result
  } finally {
    client.off('extension-ui', onStatus)
  }
}

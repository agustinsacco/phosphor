import type { parseSettingsRead } from '@phosphor/shared/machine-settings'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { runMcpList } from '@phosphor/session-runtime/pi/mcp-inspection'
import type { SettingsContext } from './context'
import { SettingsFailure } from './files'

function checkedServers(stdout: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.slice(stdout.indexOf('{')))
  } catch {
    throw new SettingsFailure('internal', 'pi did not return connector status.')
  }
  if (!machineRecord(parsed) || !Array.isArray(parsed.servers) || parsed.servers.length > 128)
    throw new SettingsFailure('internal', 'Invalid connector status.')
  const servers = new Map<string, { state: string; tools: number }>()
  for (const raw of parsed.servers) {
    if (
      !machineRecord(raw) ||
      typeof raw.name !== 'string' ||
      typeof raw.state !== 'string' ||
      ![
        'connected',
        'needs-auth',
        'failed',
        'disconnected',
        'connecting',
        'closed',
        'disabled',
      ].includes(raw.state)
    )
      continue
    servers.set(raw.name, {
      state: raw.state,
      tools: Array.isArray(raw.tools) ? Math.min(raw.tools.length, 10000) : 0,
    })
  }
  return servers
}

export async function checkConnectors(
  state: SettingsContext,
  read: ReturnType<typeof parseSettingsRead>,
  authorized: () => boolean,
) {
  if (!read || read.section !== 'connectors')
    throw new SettingsFailure('bad-request', 'Only connector status can be checked here.')
  const { options } = state
  const cwd = state.workspace(read.repositoryId)
  const checkedRevision = state.revision('connectors', cwd)
  const checkedGeneration = state.connectorGeneration
  const result = await runMcpList(
    { ...options.pi, cwd: cwd ?? options.context.home, env: options.env },
    { timeoutMs: 25_000 },
  )
  if (!authorized()) throw new SettingsFailure('forbidden', 'Configuration access was revoked.')
  if (
    checkedGeneration !== state.connectorGeneration ||
    checkedRevision !== state.revision('connectors', state.workspace(read.repositoryId))
  )
    throw new SettingsFailure(
      'bad-request',
      'Configuration or authentication changed during the check. Review and check again.',
    )
  if (result.error)
    throw new SettingsFailure('internal', 'Connector status check did not finish. Try again.')
  const servers = checkedServers(result.stdout)
  if (state.connectorChecks.size >= 64 && !state.connectorChecks.has(read.repositoryId ?? ''))
    state.connectorChecks.delete(state.connectorChecks.keys().next().value!)
  state.connectorChecks.set(read.repositoryId ?? '', {
    at: Date.now(),
    revision: checkedRevision,
    servers,
  })
}

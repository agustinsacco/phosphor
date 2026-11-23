import { isDeepStrictEqual } from 'node:util'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import type { MachineSettings, MachineSettingsChange } from '@phosphor/shared/machine-settings'
import { mcpUsesOAuth, type McpServerConfig } from '@phosphor/shared/mcp'
import { validMcpConfig } from '@phosphor/shared/machine-settings-mcp'
import { SettingsFailure } from '@phosphor/session-runtime/pi/settings-file'

type Mutation = Extract<MachineSettingsChange, { type: `mcp.${string}` }>
const AGENT_FIELDS = new Set([
  'url',
  'type',
  'args',
  'command',
  'cwd',
  'enabled',
  'description',
  'timeout',
  'exposure',
])
const signOutFirst = () =>
  new SettingsFailure(
    'forbidden',
    'Remove or retarget this connector in Settings → Connectors; Phosphor signs it out there.',
  )

/** Run under the settings lock. Never change which program/endpoint can use private fields. */
export function guardedEntry(
  existing: unknown,
  change: Mutation,
  before: MachineSettings,
  replace: boolean,
) {
  const row = before.connectors?.servers.find((s) => s.name === change.name)
  if (change.type === 'mcp.enabled') return
  if (!existing && !replace && change.type === 'mcp.upsert') {
    // A project shadow can retarget an inherited machine connector, too.
    if (before.repositoryId && row && row.transport !== 'stdio' && row.oauth !== false)
      throw signOutFirst()
    return change.config
  }
  if (!existing || !machineRecord(existing))
    throw new SettingsFailure('bad-request', 'No connector in this scope.')
  const oauth = validMcpConfig(existing) ? mcpUsesOAuth(existing) : true
  if (change.type === 'mcp.remove') {
    if (oauth) throw signOutFirst()
    return
  }
  if (!replace) return change.config // the normal add path refuses an existing entry
  if (oauth && (!existing.url || existing.url !== change.config.url)) throw signOutFirst()
  const privateFields = Object.entries(existing).filter(([key]) => !AGENT_FIELDS.has(key))
  if (
    privateFields.length &&
    ['command', 'cwd', 'args', 'url'].some(
      (key) => !isDeepStrictEqual(existing[key], change.config[key as keyof McpServerConfig]),
    )
  )
    throw new SettingsFailure(
      'forbidden',
      'Edit this connector in Settings; it has private or unmanaged fields.',
    )
  return { ...Object.fromEntries(privateFields), ...change.config }
}

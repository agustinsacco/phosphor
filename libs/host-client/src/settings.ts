import {
  parseSettingsPatch,
  parseSettingsRead,
  isMachineAccountId,
  type MachineSettingsPatch,
  type MachineSettingsSection,
} from '@phosphor/shared/machine-settings'
import { parseMachineSettings } from '@phosphor/shared/machine-settings-result'
import { splitGrant } from '@phosphor/shared/host-grant'
import type { createHostConnection } from './connection'

type Connection = Pick<
  ReturnType<typeof createHostConnection>,
  'snapshot' | 'incarnation' | 'call' | 'send'
>

/**
 * Host settings over one Host connection, shared by Desktop and the browser.
 * Machine-scoped only. Missing authority or a replaced connection never falls back locally.
 */
export function machineSettings(connection: (hostId: string) => Connection | undefined) {
  async function call(
    hostId: string,
    method: string,
    params: { section: MachineSettingsSection; repositoryId?: string },
  ) {
    const c = connection(hostId)
    if (
      !c ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes('machine.configure')
    )
      throw new Error('Connect to this Host and enable configuration access first.')
    const generation = c.incarnation().generation
    const result = await c.call(method, params)
    if (
      connection(hostId) !== c ||
      c.incarnation().generation !== generation ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes('machine.configure')
    )
      throw new Error(
        'Host settings operation not confirmed. Reconnect and reload before trying again.',
      )
    if (!result.ok)
      throw new Error(
        result.error.code === 'bad-request'
          ? result.error.message.slice(0, 300)
          : 'Host settings are unavailable or configuration access was refused.',
      )
    const parsed = parseMachineSettings(result.data)
    if (!parsed || parsed.section !== params.section || parsed.repositoryId !== params.repositoryId)
      throw new Error('The Host returned invalid settings. Nothing local was used.')
    return parsed
  }
  return {
    async moveAccount(hostId: string, laneId: string, accountId: string) {
      const c = connection(hostId)
      if (!c || !isMachineAccountId(accountId)) throw new Error('Invalid Host account move.')
      const generation = c.incarnation().generation
      const available = () =>
        connection(hostId) === c &&
        c.incarnation().generation === generation &&
        c.snapshot().state === 'ready' &&
        ['machine.configure', 'sessions.control'].every((cap) =>
          c.snapshot().capabilities.includes(cap as 'machine.configure' | 'sessions.control'),
        )
      if (!available())
        throw new Error('Connect to this Host and enable configuration access first.')
      const lane = c.snapshot().lanes.find((lane) => lane.laneId === laneId)
      if (!lane) throw new Error('Open this Host lane before moving it to another account.')
      const receipt = await c.send(
        { type: 'claude.account', accountId },
        laneId,
        lane.control.fence,
      )
      if (!available() || receipt.status !== 'done')
        throw new Error(
          'Account move not confirmed. Check the Host lane before retrying; it may be stopped. Another client’s lane control is never taken automatically.',
        )
    },
    read(hostId: string, section: MachineSettingsSection, repositoryId?: string) {
      const params = parseSettingsRead({ section, repositoryId })
      if (!params) throw new Error('Invalid machine settings request.')
      return call(hostId, 'machine.settings.read', params)
    },
    check(hostId: string, repositoryId?: string) {
      const params = parseSettingsRead({ section: 'connectors', repositoryId })
      if (!params) throw new Error('Invalid connector status request.')
      return call(hostId, 'machine.settings.check', params)
    },
    patch(hostId: string, change: MachineSettingsPatch) {
      const params = parseSettingsPatch(change)
      if (!params) throw new Error('Invalid machine settings change.')
      return call(hostId, 'machine.settings.patch', params)
    },
  }
}

/** Per-Host configure opt-in and the grant it changes. Each client keeps it in memory only. */
export interface ConfigurationGrants {
  /** Ask for (or stop asking for) `configure: true` in this Host's grants; drops its cached grant. */
  configure(hostId: string, enabled?: boolean): void
  grantFor(hostId: string): Promise<{ grant: string }>
}

/**
 * The explicit "Enable configuration access" step: opt in, prove the control plane signed a
 * configure grant, then reconnect so the Host admits it. A refused upgrade rolls the opt-in back.
 */
export async function enableConfigurationAccess(
  ports: {
    connection: (hostId: string) => Pick<Connection, 'snapshot'> | undefined
    grants: ConfigurationGrants
    reconnect: (hostId: string) => Promise<void>
  },
  hostId: string,
): Promise<void> {
  const c = ports.connection(hostId)
  if (!c || c.snapshot().state !== 'ready' || !c.snapshot().configurationSupported)
    throw new Error('Connect to an updated Host before enabling settings access.')
  ports.grants.configure(hostId)
  try {
    const grant = splitGrant((await ports.grants.grantFor(hostId)).grant)
    if (!grant.ok || !grant.value.payload.configure) throw new Error('unsupported-control')
  } catch {
    ports.grants.configure(hostId, false)
    throw new Error(
      'The control plane did not grant configuration access. Update it or sign in again, then retry. Existing lane access was not changed.',
    )
  }
  await ports.reconnect(hostId)
}

import { splitGrant } from '@shared/host-grant'
import { machineSettings } from '../hosts/settings'
import type { createHostManager } from '../hosts/manager'
import type { createGrants } from '../hosts/grants'
import type { createRemoteTerminals } from '../hosts/terminals'
import { handle } from './handle'

/** Feature-only registrars, leaving the deferred Host runtime/router refactor untouched. */
export function registerHostSettingsHandlers(
  manager: Pick<ReturnType<typeof createHostManager>, 'connection' | 'reconnect'>,
  grants: Pick<ReturnType<typeof createGrants>, 'configure' | 'grantFor'>,
  terminals: Pick<ReturnType<typeof createRemoteTerminals>, 'task' | 'signIn'>,
): void {
  const settings = machineSettings(manager.connection)
  handle('hosts:providerLogin', (event, hostId, provider, account) =>
    terminals.signIn(event.sender.id, hostId, provider, account),
  )
  handle('hosts:settingsAccess', async (_event, hostId) => {
    const c = manager.connection(hostId)
    if (!c || c.snapshot().state !== 'ready' || !c.snapshot().configurationSupported)
      throw new Error('Connect to an updated Host before enabling settings access.')
    grants.configure(hostId)
    try {
      const grant = splitGrant((await grants.grantFor(hostId)).grant)
      if (!grant.ok || !grant.value.payload.configure) throw new Error('unsupported-control')
    } catch {
      grants.configure(hostId, false)
      throw new Error(
        'The control plane did not grant configuration access. Update it or sign in again, then retry. Existing lane access was not changed.',
      )
    }
    await manager.reconnect(hostId)
  })
  handle('hosts:settingsRead', (_event, hostId, section, repositoryId) =>
    settings.read(hostId, section, repositoryId),
  )
  handle('hosts:settingsPatch', (_event, hostId, patch) => settings.patch(hostId, patch))
  handle('hosts:claudeAccount', (_event, hostId, laneId, accountId) =>
    settings.moveAccount(hostId, laneId, accountId),
  )
  handle('hosts:settingsCheck', (_event, hostId, repositoryId) =>
    settings.check(hostId, repositoryId),
  )
  handle('hosts:machineTask', (event, hostId, task) =>
    terminals.task(event.sender.id, hostId, task),
  )
}

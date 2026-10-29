import { enableConfigurationAccess, machineSettings } from '@phosphor/host-client/settings'
import type { createHostManager } from '../hosts/manager'
import type { createGrants } from '../hosts/grants'
import type { createRemoteTerminals } from '@phosphor/host-client/terminals/terminals'
import { ptyManager } from '../pty/pty-manager'
import { handle } from './handle'

/** Feature-only registrars, leaving the deferred Host runtime/router refactor untouched. */
export function registerHostSettingsHandlers(
  manager: Pick<ReturnType<typeof createHostManager>, 'connection' | 'reconnect'>,
  grants: Pick<ReturnType<typeof createGrants>, 'configure' | 'grantFor'>,
  terminals: Pick<ReturnType<typeof createRemoteTerminals>, 'task' | 'signIn' | 'shell'>,
): void {
  const settings = machineSettings(manager.connection)
  handle('hosts:providerLogin', (event, hostId, provider, account) =>
    terminals.signIn(event.sender.id, hostId, provider, account),
  )
  handle('hosts:settingsAccess', (_event, hostId) =>
    enableConfigurationAccess(
      { connection: manager.connection, grants, reconnect: (id) => manager.reconnect(id) },
      hostId,
    ),
  )
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
  handle('hosts:machineShell', (event, hostId, cols, rows) =>
    hostId === 'local'
      ? ptyManager.createHome(cols, rows)
      : terminals.shell(event.sender.id, hostId, cols, rows),
  )
}

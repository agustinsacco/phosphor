import { app } from 'electron'
import { hostname } from 'node:os'
import { accountUserId, onAccountChange } from '../account'
import { broadcast } from '../broadcast'
import { log } from '../debug-log'
import { getRemoteClients, setRemoteClients } from '../store'
import { createClientIds } from '../hosts/client-id'
import { createGrants } from '../hosts/grants'
import { createHostConnection } from '../hosts/connection'
import { createHostManager } from '../hosts/manager'
import { openHostSocket } from '../hosts/socket'
import { controlClient, onMachinesChanged } from './control-handlers'
import { handle } from './handle'

export function registerHostsHandlers(): void {
  const control = controlClient()
  const clients = createClientIds({
    user: accountUserId,
    read: getRemoteClients,
    write: setRemoteClients,
    hostname,
    control,
  })
  const grants = createGrants({ control, clients, present: (id) => manager.present(id) })
  const manager = createHostManager({
    user: accountUserId,
    accountChanged: (cb) => onAccountChange(cb),
    machinesChanged: onMachinesChanged,
    machines: () => control.machines(),
    clearGrants: (id) => grants.clear(id),
    changed: () => broadcast('hosts:changed', undefined),
    connection: (hostId, endpoint) =>
      createHostConnection({
        hostId,
        endpoint,
        socket: openHostSocket,
        grant: () => grants.grantFor(hostId),
        clearGrant: () => grants.clear(hostId),
        changed: () => manager.changed(),
        disabled: () => manager.disabled(),
        log,
      }),
  })
  app.once('will-quit', () => manager.stop())
  handle('hosts:snapshot', () => manager.snapshot())
}

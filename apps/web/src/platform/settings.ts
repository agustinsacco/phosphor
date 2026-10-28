import {
  enableConfigurationAccess,
  machineSettings,
  type ConfigurationGrants,
} from '@phosphor/host-client/settings'
import type { BrowserControl } from './control'
import type { BrowserHosts } from './hosts'

/**
 * Host machine settings in the browser, through the same shared checks Desktop makes: every call
 * needs a ready connection holding `machine.configure`, and goes only to that Host.
 */
export function createBrowserSettings(ports: {
  control: Pick<BrowserControl, 'configure'>
  hosts: Pick<BrowserHosts, 'connection' | 'present' | 'grantFor' | 'forgetGrant' | 'reconnect'>
}) {
  const { control, hosts } = ports
  const settings = machineSettings(hosts.connection)
  const grants: ConfigurationGrants = {
    configure(hostId, enabled = true) {
      if (enabled && !hosts.present(hostId)) throw new Error('grant-refused')
      control.configure(hostId, enabled)
      hosts.forgetGrant(hostId)
    },
    grantFor: (hostId) => hosts.grantFor(hostId),
  }
  return {
    access: (hostId: string) =>
      enableConfigurationAccess(
        { connection: hosts.connection, grants, reconnect: (id) => hosts.reconnect(id) },
        hostId,
      ),
    read: settings.read,
    patch: settings.patch,
    check: settings.check,
    moveAccount: settings.moveAccount,
  }
}

import type { GrantIssueResponse } from '@shared/control-api'
import type { DesktopControlErrorCode } from '@shared/ipc'
import { createGrantCache } from '@phosphor/host-client/grant-cache'
import type { createControlClient } from '../control/client'
import type { createClientIds } from './client-id'
import type { createConfigureHosts } from './configure-hosts'

interface GrantPorts {
  control: Pick<ReturnType<typeof createControlClient>, 'grant'>
  clients: ReturnType<typeof createClientIds>
  present: (hostId: string) => boolean
  /** Persisted per account; a full `clear()` (account change, quit) leaves it alone. */
  configured: Pick<ReturnType<typeof createConfigureHosts>, 'has' | 'set'>
  now?: () => number
}
function grantFailure(code: DesktopControlErrorCode): Error {
  return new Error(
    code === 'not-found' ? 'grant-refused' : code === 'forbidden' ? 'account-disabled' : code,
  )
}

export function createGrants(ports: GrantPorts) {
  const cache = createGrantCache({
    now: ports.now,
    present: ports.present,
    async issue(hostId, current) {
      const request = async () =>
        ports.configured.has(hostId)
          ? ports.control.grant(hostId, await ports.clients.get(), true)
          : ports.control.grant(hostId, await ports.clients.get())
      const result = await request()
      return !result.ok &&
        result.error.code === 'not-found' &&
        current() &&
        (await ports.clients.replace())
        ? request()
        : result
    },
    readGrant(hostId, result): GrantIssueResponse {
      if (!result.ok) throw grantFailure(result.error.code)
      if (result.host.id !== hostId) throw new Error('grant-refused')
      return result
    },
  })
  return {
    /** Explicitly requested from this machine's Settings page; forgotten on sign-out. */
    configure(hostId: string, enabled = true) {
      if (enabled && !ports.present(hostId)) throw new Error('grant-refused')
      ports.configured.set(hostId, enabled)
      this.clear(hostId)
    },
    clear(hostId?: string) {
      cache.clear(hostId)
      if (!hostId) ports.clients.clear()
    },
    grantFor: cache.grantFor,
  }
}

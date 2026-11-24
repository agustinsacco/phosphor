import { op } from '@phosphor/session-runtime/ops/results'
import type { ReachMachine } from '@phosphor/session-runtime/ops/reach'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import { DIRECTORY_REFUSALS } from '../../reach'
import { HOST_ID_PREFIX_MIN } from '../remote'
import type { DaemonHandlerDeps } from './index'

const WHY: Readonly<Record<NonNullable<ReachMachine['why']>, string>> = {
  offline: 'offline',
  'update-host': 'update that Host',
  'reach-off': 'machine reach is off there',
}

function machineLine(m: ReachMachine): string {
  const id = m.id.slice(0, HOST_ID_PREFIX_MIN)
  const version = m.hostVersion ? `Host ${m.hostVersion}` : 'version unknown'
  // Online but without a tailnet address reads as offline in the directory.
  const why =
    m.why === 'offline' && m.online ? 'unreachable on your tailnet' : m.why ? WHY[m.why] : ''
  const state = m.ready ? 'ready' : `not ready: ${why}`
  return `${m.label} (${id}): ${m.online ? 'online' : 'offline'}, ${version}, ${state}`
}

/**
 * `hosts.list`: the machines `--host` can name, from the reach directory
 * (cached 30 s): label, id prefix, online, Host version, and why one is not
 * ready. This machine is listed first and is never part of `--host all`.
 */
export function hostsHandlers(
  deps: Pick<DaemonHandlerDeps, 'directory'>,
): Readonly<Record<string, OpHandler>> {
  return {
    'hosts.list': op(async () => {
      if (!deps.directory)
        return {
          text: 'This machine cannot reach other machines.',
          data: { available: false },
        }
      const listing = await deps.directory()
      if (!listing.available)
        return { text: DIRECTORY_REFUSALS[listing.reason].message, data: listing }
      const self = `This machine: ${listing.self.label} (${listing.self.id.slice(0, HOST_ID_PREFIX_MIN)})`
      const machines = listing.machines.filter((m) => m.id !== listing.self.id)
      const others = machines.length
        ? machines.map(machineLine)
        : ['No other machines on your account.']
      return { text: [self, ...others].join('\n'), data: listing }
    }),
  }
}

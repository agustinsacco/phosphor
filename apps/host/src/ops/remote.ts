/**
 * `--host` on the Phosphor service, resolved against control's machine
 * directory (X3 reach). An exact label (any case) or an id prefix of at least
 * eight hex characters names a machine; a value that matches more than one
 * lists the candidates. Either of this machine's ids (enrolled or local) or
 * its label names this machine, which then runs the op here; naming it beside
 * other machines is refused. `all` is every other machine, in directory order,
 * and never this one. Living contract: docs/agent-control.md ("Machines").
 */
import type { OpsHostResolver, RoutedHost } from '@phosphor/session-runtime/ops/ports'
import type { Reach } from '@phosphor/session-runtime/ops/reach'
import { DIRECTORY_REFUSALS } from '../reach'

/** Hex characters an id prefix needs before it names a machine. */
export const HOST_ID_PREFIX_MIN = 8

export interface HostResolverPorts {
  readonly directory: Reach['directory']
  /** This machine's ids: the enrolled Host id and a local daemon's machine id. */
  readonly selfIds: () => readonly string[]
}

interface Candidate extends RoutedHost {
  readonly self: boolean
}

function idPrefix(value: string, id: string): boolean {
  return (
    /^[0-9a-f][0-9a-f-]*$/i.test(value) &&
    value.replace(/-/g, '').length >= HOST_ID_PREFIX_MIN &&
    id.toLowerCase().startsWith(value.toLowerCase())
  )
}

/** The machines one value names; this machine counts once, whichever of its ids matched. */
function named(value: string, candidates: readonly Candidate[]): Candidate[] {
  const exact = candidates.find((c) => c.id === value)
  if (exact) return [exact]
  const found = candidates.filter(
    (c) => c.label.toLowerCase() === value.toLowerCase() || idPrefix(value, c.id),
  )
  const self = found.find((c) => c.self)
  return [...(self ? [self] : []), ...found.filter((c) => !c.self)]
}

const describe = (c: Candidate): string =>
  `${c.label} (${c.self ? 'this machine' : c.id.slice(0, HOST_ID_PREFIX_MIN)})`

type Resolution = Awaited<ReturnType<OpsHostResolver['resolve']>>
const fail = (text: string): Resolution => ({ ok: false, text })

function pick(values: readonly string[], candidates: readonly Candidate[]): Resolution {
  const picked: RoutedHost[] = []
  let namedSelf = false
  for (const value of values) {
    const found = named(value, candidates)
    const [one] = found
    if (!one) return fail(`No machine on your account matches ${value}. Run phosphor hosts.`)
    if (found.length > 1)
      return fail(`Several machines match ${value}: ${found.map(describe).join(', ')}.`)
    if (one.self) namedSelf = true
    else if (!picked.some((p) => p.id === one.id)) picked.push(routed(one))
  }
  if (!namedSelf) return { ok: true, hosts: picked }
  return picked.length === 0 ? { ok: true, self: true } : fail('Leave this machine out of --host.')
}

function routed({ id, label, machine }: Candidate): RoutedHost {
  return { id, label, machine }
}

/** The dispatcher's `--host` resolver over the reach directory. */
export function createHostResolver(ports: HostResolverPorts): OpsHostResolver {
  return {
    isSelf: (hostId) => ports.selfIds().includes(hostId),
    async resolve(hosts, budget) {
      const selfIds = new Set(ports.selfIds())
      // This machine's own id needs no directory.
      if (hosts !== 'all' && hosts.length === 1 && selfIds.has(hosts[0]!))
        return { ok: true, self: true }
      const listing = await ports.directory(budget)
      if (!listing.available) return fail(DIRECTORY_REFUSALS[listing.reason].message)
      selfIds.add(listing.self.id)
      const others = listing.machines
        .filter((m) => !selfIds.has(m.id))
        .map((m): Candidate => ({ id: m.id, label: m.label, machine: m, self: false }))
      if (hosts === 'all') return { ok: true, hosts: others.map(routed) }
      const self = [...selfIds].map((id): Candidate => ({
        id,
        label: listing.self.label,
        self: true,
      }))
      return pick(hosts, [...self, ...others])
    },
  }
}

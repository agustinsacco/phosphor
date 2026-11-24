import { isAbsolute, join } from 'node:path'
import type { HostConnectionSnapshot, createHostConnection } from '@phosphor/host-client/connection'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import type { MachineChannel } from '@phosphor/shared/ipc-scope'
import { rewriteResourceArgs } from '../ipc/machine-resource-args'

/**
 * This Mac's own service, as the same-machine routes see it: its Host id and
 * its connection's projection. `host:<id>/lane:<laneId>` names a lane's
 * folder and `host:<id>/repo:<repositoryId>` a folder the service keeps, so a
 * same-machine handler can run on the real path (`LOCAL_ROUTE`). Nothing here
 * is consulted unless the launch gate chose daemon mode.
 */

export type SameMachineConnection = Pick<
  ReturnType<typeof createHostConnection>,
  'snapshot' | 'call'
>

export interface SameMachineBinding {
  hostId: string
  connection: () => SameMachineConnection | undefined
}

/** A ready connection to This Mac's service and the projection it sent. */
export interface SameMachineView {
  hostId: string
  connection: SameMachineConnection
  repositories: HostConnectionSnapshot['repositories']
  lanes: HostConnectionSnapshot['lanes']
}

let binding: SameMachineBinding | null = null

/** The host manager's local slot, or null once it detaches. */
export function bindSameMachine(next: SameMachineBinding | null): void {
  binding = next
}

/** The local slot even before it is ready. Never resolves another machine. */
export function localSlotConnection(): SameMachineConnection | undefined {
  return binding?.connection()
}

/** Undefined while no local slot exists or its connection is not ready. */
export function sameMachine(): SameMachineView | undefined {
  const connection = localSlotConnection()
  if (!binding || !connection) return undefined
  const view = connection.snapshot()
  if (view.state !== 'ready') return undefined
  return {
    hostId: binding.hostId,
    connection,
    repositories: view.repositories,
    lanes: view.lanes,
  }
}

/** The longest `host:` key resolved; longer keys are refused. */
export const MAX_SAME_MACHINE_KEY = 4096
const KEY = /^host:([^/]+)\/(lane|repo):([^/]+)((?:\/[^/]+)*)$/

/**
 * The real path a `host:<this Mac>/lane:<id>[/rest]` or `/repo:<id>[/rest]`
 * key names, from the projection. Null for any other Host, an unknown lane or
 * folder, a dot segment, or an oversized key.
 */
export function resolveSameMachineKey(
  key: string,
  view: Pick<SameMachineView, 'hostId' | 'repositories' | 'lanes'>,
): string | null {
  if (key.length > MAX_SAME_MACHINE_KEY || key.includes('\0')) return null
  const match = KEY.exec(key)
  if (!match || match[1] !== view.hostId) return null
  const [, , kind, id, rest = ''] = match
  const segments = rest.split('/').slice(1)
  if (segments.some((segment) => segment === '.' || segment === '..')) return null
  const root =
    kind === 'lane'
      ? view.lanes.find((lane) => lane.laneId === id)?.cwd
      : view.repositories.find((repository) => repository.id === id)?.path
  if (!root || !isAbsolute(root)) return null
  return segments.length ? join(root, ...segments) : root
}

/**
 * A daemon-mode call's arguments with This Mac's `host:` keys replaced by
 * their real paths, or null when no selected position names This Mac (other
 * Hosts keep today's routing and refusal). Throws the remote refusal when one
 * names This Mac but cannot be resolved, or its connection is not ready.
 */
export function sameMachineArgs(
  channel: MachineChannel,
  args: readonly unknown[],
): unknown[] | null {
  const hostId = binding?.hostId
  if (!hostId) return null
  const prefix = `host:${hostId}/`
  let named = false
  const probe = rewriteResourceArgs(channel, args, (key) => {
    if (key.startsWith(prefix)) named = true
    return key
  })
  if (!named) return null
  const view = sameMachine()
  if (!view) throw new Error(REMOTE_UNAVAILABLE)
  return rewriteResourceArgs(channel, probe, (key) => {
    if (!key.startsWith(prefix)) return key
    const path = resolveSameMachineKey(key, view)
    if (path === null) throw new Error(REMOTE_UNAVAILABLE)
    return path
  })
}

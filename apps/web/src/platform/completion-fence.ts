import type { HostsSnapshot, IpcInvokeChannel } from '@phosphor/shared/ipc'
import type { LiveSessionInfo } from '@phosphor/shared/models'

/** Only transports actually used by an operation may invalidate its completion. */
export function captureCompletionFence(
  channel: IpcInvokeChannel,
  args: unknown[],
  snapshot: () => HostsSnapshot,
  sessions: LiveSessionInfo[],
): () => boolean {
  const before = snapshot()
  const aggregate =
    channel === 'artifacts:list' || (channel === 'routines:list' && args[0] === undefined)
  let ids: string[]
  if (aggregate) ids = Object.keys(before).sort()
  else {
    const key = channel === 'routines:save' ? (args[3] ?? args[1]) : args[0]
    const session =
      typeof key === 'string' ? sessions.find((session) => session.sessionId === key) : undefined
    const host =
      session?.target?.kind === 'remote'
        ? session.target.hostId
        : typeof key === 'string' && key.startsWith('host:')
          ? /^host:([^/]+)/.exec(key)?.[1]
          : channel.startsWith('hosts:') && typeof key === 'string'
            ? key
            : undefined
    ids = host ? [host] : []
  }
  const tokens = ids.map((id) => before[id]?.connectionToken)
  return () => {
    const after = snapshot()
    if (aggregate && Object.keys(after).sort().join('|') !== ids.join('|')) return false
    return ids.every((id, index) => after[id]?.connectionToken === tokens[index])
  }
}

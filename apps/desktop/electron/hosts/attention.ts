import type { AttentionEvent } from '@shared/host-protocol'
import type { HostAttention } from '@shared/ipc'

export function createHostAttention(ports: {
  label: (hostId: string) => string
  focused: (hostId: string, laneId: string) => boolean
  publish: (event: HostAttention) => void
  notify: (title: string, body: string, click: () => void) => void
  open: (hostId: string, laneId: string) => void
}) {
  const seen = new Set<string>()
  return {
    clear: () => seen.clear(),
    receive(hostId: string, event: AttentionEvent) {
      const key = `${hostId}/${event.id}`
      if (seen.has(key)) return
      seen.add(key)
      if (seen.size > 1600) {
        const oldest = seen.values().next().value
        if (oldest) seen.delete(oldest)
      }
      const kind = event.kind.startsWith('routine-') ? 'routine' : event.kind
      const attention: HostAttention = {
        hostId,
        laneId: event.laneId,
        kind: kind === 'finished' || kind === 'needs-input' || kind === 'failed' ? kind : 'routine',
        title: event.title ?? 'Untitled lane',
        at: event.at,
      }
      ports.publish(attention)
      if (!ports.focused(hostId, event.laneId))
        ports.notify(ports.label(hostId), `${attention.title} · ${attention.kind}`, () =>
          ports.open(hostId, event.laneId),
        )
    },
  }
}

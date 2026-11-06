import type { HostAttention } from '@shared/ipc'
import { receiptSummary } from '@shared/lane-receipt'
import { createAttentionReceiver } from '@phosphor/host-client/attention'

export interface AttentionPorts {
  receipt?: (hostId: string, laneId: string) => Promise<unknown>
  label: (hostId: string) => string
  focused: (hostId: string, laneId: string) => boolean
  publish: (event: HostAttention) => void
  notify: (title: string, body: string, click: () => void) => void
  open: (hostId: string, laneId: string) => void
}

/** The shared receiver, plus an OS notification for a lane no focused window shows. */
export function createHostAttention(ports: AttentionPorts) {
  return createAttentionReceiver({
    receipt: ports.receipt,
    focused: ports.focused,
    publish: (attention) => {
      ports.publish(attention)
      const { hostId, laneId } = attention
      if (!ports.focused(hostId, laneId))
        ports.notify(
          `${ports.label(hostId)} · ${attention.title}`,
          notificationBody(attention),
          () => ports.open(hostId, laneId),
        )
    },
  })
}

/** Receipt facts only: the reply excerpt and paths stay off the lock screen. */
function notificationBody(attention: HostAttention): string {
  if (attention.receipt) return receiptSummary(attention.receipt)
  return attention.kind === 'failed'
    ? 'Stopped'
    : attention.kind === 'finished'
      ? 'Done'
      : attention.kind
}

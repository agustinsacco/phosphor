import type { HostAttention } from '@shared/ipc'
import { attentionNotice } from '@phosphor/shared/notifications'
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
      if (!ports.focused(hostId, laneId)) {
        const notice = attentionNotice(ports.label(hostId), attention)
        ports.notify(notice.title, notice.body, () => ports.open(hostId, laneId))
      }
    },
  })
}

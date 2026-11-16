import { createAttentionReceiver, readHostReceipt } from '@phosphor/host-client/attention'
import { attentionNotice } from '@phosphor/shared/notifications'
import type { HostAttention } from '@phosphor/shared/ipc'
import { createBrowserNotifications } from './notifications'

/** Account/disposal fences cover both receipt reads and native delivery waiting for a worker. */
export function createBrowserAttention(ports: {
  connection: Parameters<typeof readHostReceipt>[0]
  label(hostId: string): string
  publish(notice: HostAttention): void
  generation(): number | undefined
}) {
  const notifications = createBrowserNotifications()
  return createAttentionReceiver({
    receipt: (hostId, laneId) => readHostReceipt(ports.connection, hostId, laneId),
    publish: (notice) => {
      const epoch = ports.generation()
      if (epoch === undefined) return
      ports.publish(notice)
      void notifications.attention(
        attentionNotice(ports.label(notice.hostId), notice),
        () => epoch === ports.generation(),
      )
    },
  })
}

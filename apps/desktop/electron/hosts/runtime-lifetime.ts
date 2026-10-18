import { app, BrowserWindow, Notification } from 'electron'
import type { SessionPush } from '@shared/models'
import { accountUserId, onAccountChange } from '../account'
import { broadcast } from '../broadcast'
import { createHostAttention, readHostReceipt } from './attention'
import type { HostRuntime } from './runtime'
import type { createHostManager } from './manager'
import type { RemoteLanes } from './remote-lanes'

export function initAttention(manager: ReturnType<typeof createHostManager>, remote: RemoteLanes) {
  return createHostAttention({
    receipt: (hostId, laneId) => readHostReceipt(manager.connection, hostId, laneId),
    label: manager.label,
    focused: (hostId, laneId) =>
      BrowserWindow.getAllWindows().some(
        (win) => win.isFocused() && remote.focused(hostId, laneId, win.webContents.id),
      ),
    publish: (event) => broadcast('hosts:attention', event),
    notify: (title, body, click) => {
      if (!Notification.isSupported()) return
      const notification = new Notification({ title, body })
      notification.once('click', click)
      notification.show()
    },
    open: (hostId, laneId) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      if (win) {
        win.show()
        win.focus()
        win.webContents.send('hosts:openLaneRequested', { hostId, laneId })
      }
    },
  })
}

export function installLifetime(
  { terminals, routines, remote, attention, manager }: HostRuntime,
  stopped: () => void,
) {
  let user = accountUserId()
  const off = onAccountChange(() => {
    const next = accountUserId()
    if (next !== user) {
      terminals?.clear()
      routines?.clear()
      remote?.clear()
      attention.clear()
      user = next
    }
  })
  const windows = new Set<number>()
  function window(event: Electron.IpcMainInvokeEvent) {
    const sender = event.sender
    if (!windows.has(sender.id)) {
      windows.add(sender.id)
      sender.once('destroyed', () => {
        terminals?.clear(sender.id)
        remote?.closeWindow(sender.id)
        windows.delete(sender.id)
      })
    }
    return {
      id: sender.id,
      send: (channel: string, push: SessionPush) => sender.send(channel, push),
      destroyed: () => sender.isDestroyed(),
    }
  }
  app.once('will-quit', () => {
    off()
    terminals?.clear()
    remote?.clear()
    stopped()
    manager.stop()
  })
  return window
}

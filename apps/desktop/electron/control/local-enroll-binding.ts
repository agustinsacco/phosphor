import { Notification } from 'electron'
import { accountUserId, onAccountChange } from '../account'
import { broadcast } from '../broadcast'
import type { createHostManager } from '../hosts/manager'
import { piStubPath } from '../pi/stub'
import { getLocalEnrolledId, setLocalEnrolledId } from '../prefs/backend'
import type { createControlClient } from './client'
import { monitorLocalEnrollment } from './local-enroll-monitor'

export function bindLocalEnrollment(
  manager: ReturnType<typeof createHostManager>,
  control: ReturnType<typeof createControlClient>,
  localId: () => string | undefined,
) {
  const directory = (id: Parameters<typeof manager.directory>[0]) => {
    if (manager.directory(id)) broadcast('control:machinesChanged', undefined)
  }
  directory(getLocalEnrolledId())
  const enroll = monitorLocalEnrollment({
    user: accountUserId,
    local: () => {
      const id = localId()
      const connection = id ? manager.connection(id) : undefined
      return id && connection ? { hostId: id, connection } : undefined
    },
    control,
    directory,
    remember: setLocalEnrolledId,
    notice: (body) => {
      if (!piStubPath() && Notification.isSupported())
        new Notification({ title: 'Phosphor enrollment', body }).show()
    },
  })
  const offAccount = onAccountChange(enroll.changed)
  // The projection changes on lane traffic too. Coalesce those callbacks instead of
  // copying every lane on every frame; current() still checks the socket before approval.
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    changed() {
      timer ??= setTimeout(() => {
        timer = undefined
        enroll.changed()
      }, 250)
      timer.unref()
    },
    stop() {
      if (timer) clearTimeout(timer)
      enroll.stop()
      offAccount()
    },
  }
}

import type { SameMachineConnection } from '../local-machine/same-machine'
import { syncLocalEnrollment } from './local-enroll'

type SyncPorts = Parameters<typeof syncLocalEnrollment>[0]
type MonitorPorts = Pick<SyncPorts, 'control' | 'directory' | 'remember' | 'notice'> & {
  user(): string | null
  local(): { hostId: string; connection: SameMachineConnection } | undefined
}

/** Account and ready changes may arrive in either order. Poll status only to learn about CLI
 * enrollment/removal; never start another approval on a timer. */
export function monitorLocalEnrollment(p: MonitorPorts) {
  let epoch = 0
  let lastToken: string | undefined,
    lastUser: string | null = null
  let inFlight = false,
    requested = false,
    stopped = false
  let attempt = true
  function check(poll = false) {
    if (stopped) return
    const local = p.local()
    const snapshot = local?.connection.snapshot()
    const token =
      snapshot?.state === 'ready' && snapshot.ownerLocal ? snapshot.connectionToken : undefined
    const user = p.user()
    if (user !== lastUser || token !== lastToken) {
      lastToken = token
      lastUser = user
      epoch++
      attempt = true
      requested = true
    }
    if (!local || !token || inFlight || !(requested || poll)) return
    requested = false
    inFlight = true
    const generation = epoch
    const current = () => {
      if (stopped || generation !== epoch || user !== p.user()) return false
      const next = p.local()?.connection.snapshot()
      return next?.state === 'ready' && next.ownerLocal === true && next.connectionToken === token
    }
    const first = attempt
    attempt = false
    void syncLocalEnrollment({
      ...p,
      user,
      current,
      attempt: first,
      hostId: local.hostId,
      call: local.connection.call,
    })
      .catch(() => {
        if (current() && first && user)
          p.notice('Automatic enrollment could not finish. Local lanes are still available.')
      })
      .finally(() => {
        inFlight = false
        if (requested) check()
      })
  }
  const timer = setInterval(() => check(true), 30_000)
  timer.unref()
  return {
    changed: () => check(),
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}

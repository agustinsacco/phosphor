import type { ExtensionUIRequest } from '@phosphor/shared/rpc'
import type { LaneProjection } from '@phosphor/session-runtime/lanes/projection'

export function createProjectionDialogs(projection: LaneProjection) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  function clear(id: string) {
    clearTimeout(timers.get(id))
    timers.delete(id)
  }
  function arm(id: string, expires: number) {
    const remaining = expires - Date.now()
    const timer = setTimeout(
      () => {
        if (Date.now() < expires) arm(id, expires)
        else {
          projection.resolveDialog(id)
          timers.delete(id)
        }
      },
      Math.min(remaining, 2 ** 31 - 1),
    )
    timer.unref()
    timers.set(id, timer)
  }
  return {
    deliver(request: ExtensionUIRequest) {
      if (['select', 'confirm', 'input', 'editor'].includes(request.method)) clear(request.id)
      if ('timeout' in request && request.timeout !== undefined) {
        if (projection.view().dialogs.some((d) => d.id === request.id))
          arm(request.id, Date.now() + request.timeout)
      }
    },
    resolve(id: string) {
      clear(id)
      projection.resolveDialog(id)
    },
    dispose() {
      for (const id of timers.keys()) clear(id)
    },
  }
}

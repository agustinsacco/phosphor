import type { AccountView } from '@shared/account'
import type { createRealtime, LiveTimers } from './realtime'

export function createMachinesLive(deps: {
  snapshot: () => AccountView
  subscribe: (listener: (view: AccountView) => void) => () => void
  realtime: (
    changed: () => void,
    joined: (joined: boolean) => void,
  ) => ReturnType<typeof createRealtime>
  timers: LiveTimers
  broadcast: () => void
}): () => void {
  let client: ReturnType<typeof createRealtime> | null = null
  let joined = false
  let debounce: ReturnType<typeof setTimeout> | undefined
  let fallback: ReturnType<typeof setTimeout> | undefined
  function stop(): void {
    const old = client
    client = null
    old?.stop()
    joined = false
    if (debounce !== undefined) deps.timers.clear(debounce)
    if (fallback !== undefined) deps.timers.clear(fallback)
    debounce = fallback = undefined
  }
  function poll(): void {
    fallback = deps.timers.after(() => {
      if (!joined) deps.broadcast()
      poll()
    }, 60_000)
  }
  function apply(view: AccountView): void {
    if (!view.preview || view.account.status !== 'signed-in') return stop()
    if (client) return
    client = deps.realtime(
      () => {
        if (debounce !== undefined) return
        debounce = deps.timers.after(() => {
          debounce = undefined
          deps.broadcast()
        }, 1000)
      },
      (next) => {
        if (next === joined) return
        joined = next
        if (fallback !== undefined) deps.timers.clear(fallback)
        fallback = undefined
        if (!next && client) poll()
      },
    )
    if (!joined) poll()
  }
  const off = deps.subscribe(apply)
  apply(deps.snapshot())
  return () => {
    off()
    stop()
  }
}

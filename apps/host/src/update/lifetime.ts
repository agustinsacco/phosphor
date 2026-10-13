import { constants } from 'node:os'
import { SHUTDOWN_SIGNALS, type Drainable } from '../shutdown'

export async function installLifetime<T>(
  attach: ((target: Drainable) => () => void) | undefined,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  let finish: () => void = () => {}
  const ended = new Promise<void>((resolve) => {
    finish = resolve
  })
  const target: Drainable = {
    drain: async (reason) => {
      const name = SHUTDOWN_SIGNALS.find((s) => s === reason)
      controller.abort(name ? 128 + constants.signals[name] : 70)
      await ended
      return { state: 'stopped' }
    },
    log: { write: () => {}, hide: () => 'The install command could not finish.' },
  }
  const listeners = SHUTDOWN_SIGNALS.map((name) => ({
    name,
    run: () => {
      void target.drain(name)
    },
  }))
  const detach = attach?.(target)
  if (!attach) for (const { name, run } of listeners) process.on(name, run)
  try {
    return await work(controller.signal)
  } finally {
    finish()
    detach?.()
    if (!attach) for (const { name, run } of listeners) process.off(name, run)
  }
}

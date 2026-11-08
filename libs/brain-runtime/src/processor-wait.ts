import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { PiEvent } from '@phosphor/shared/rpc'

export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: () => void = () => {}
  const interrupted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([promise, interrupted])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}
export async function promptProcessor(
  live: LiveSession,
  message: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  let event: (value: PiEvent) => void = () => {}
  let exit = (): void => {}
  const completed = new Promise<void>((resolve, reject) => {
    event = (value) => {
      if (value.type === 'agent_end') resolve()
    }
    exit = () => reject(new Error('Brain processor exited'))
    live.client.on('event', event)
    live.client.once('exit', exit)
    live.client.request({ type: 'prompt', message }).then((response) => {
      if (!response.success) reject(new Error('Brain processor prompt failed'))
    }, reject)
  })
  try {
    await abortable(completed, signal)
  } finally {
    live.client.off('event', event)
    live.client.off('exit', exit)
  }
}

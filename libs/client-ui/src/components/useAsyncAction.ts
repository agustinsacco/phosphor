import { useState } from 'react'
import { errorText } from '@shared/errors'

export interface AsyncAction {
  /** True while a `run` is in flight — wire it to the button's `disabled`. */
  busy: boolean
  error: string | null
  /**
   * Report (or clear) a failure that never threw. Several surfaces get a
   * `{ok: false, reason}` result back rather than a rejection, and it belongs
   * in the same slot as a thrown one.
   */
  setError: (message: string | null) => void
  run: (action: () => Promise<void>) => Promise<void>
}

/**
 * The "one button, one async call" state machine: busy while it runs, the
 * message on failure, cleared on the next attempt.
 *
 * One instance can back several buttons that must not run at once — the merge
 * modal's commit and merge steps share a single busy/error pair.
 *
 * `onError` exists for the pickers that also have to hand the message to a
 * parent (the branch picker's `onBusyError`); failures reported through
 * `setError` deliberately do not fire it, matching the call sites.
 */
export function useAsyncAction(onError?: (message: string) => void): AsyncAction {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      const message = errorText(err)
      setError(message)
      onError?.(message)
    } finally {
      setBusy(false)
    }
  }

  return { busy, error, setError, run }
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { ipcErrorText } from '@phosphor/shared/errors'
import type { OpsChangedEvent } from '@phosphor/shared/ipc'
import { machineEventKey } from './agentOps'

/** Reads only: neither a focus event nor reconnection may replay a write. Keep
 * subscriptions after errors, discard out-of-order replies and late replies after unmount. */
export function useOpRead<T>(
  load: () => Promise<T>,
  machine: string,
  kind: OpsChangedEvent['kind'],
  poll = false,
) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<unknown>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const id = ++seq.current
    void load().then(
      (value) => {
        if (seq.current === id) {
          setData(value)
          setError(null)
        }
      },
      (cause) => {
        if (seq.current === id) {
          setData(null)
          setError(cause)
        }
      },
    )
  }, [load])
  useEffect(() => {
    reload()
    const unsubscribe = window.phosphor?.onOpsChanged?.((e) => {
      if (e.machine === machineEventKey(machine) && e.kind === kind) reload()
    })
    window.addEventListener('focus', reload)
    const reconnect =
      machine === 'local'
        ? window.phosphor?.onLocalMachineChanged?.((s) => {
            if (s.service === 'ready') reload()
          })
        : undefined
    const interval = poll ? window.setInterval(reload, 30_000) : undefined
    return () => {
      seq.current++
      unsubscribe?.()
      reconnect?.()
      window.removeEventListener('focus', reload)
      window.clearInterval(interval)
    }
  }, [reload, machine, kind, poll])
  return { data, error, reload }
}
export function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div role="alert" className="flex items-center gap-2">
      {ipcErrorText(error)} <Button onClick={retry}>Retry</Button>
    </div>
  )
}
/** Writes run only on a click. Lock synchronously even for a double click. */
export function useOpAction() {
  const lock = useRef(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    void action()
      .catch((e) => setError(ipcErrorText(e)))
      .finally(() => {
        lock.current = false
        setBusy(false)
      })
  }
  return { busy, error, run }
}

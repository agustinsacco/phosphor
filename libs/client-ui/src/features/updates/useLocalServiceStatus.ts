import { useCallback, useEffect, useRef, useState } from 'react'
import { ipcErrorText } from '@phosphor/shared/errors'
import type { LocalMachineStatus } from '@phosphor/shared/ipc'

/** Subscribe before the first read. An older read never overwrites a newer gate/connection push. */
export function useLocalServiceStatus() {
  const [status, setStatus] = useState<LocalMachineStatus>()
  const [error, setError] = useState('')
  const serial = useRef(0)
  const reload = useCallback(() => {
    const ticket = ++serial.current
    void window.phosphor.invoke('app:localMachine').then(
      (next) => {
        if (ticket !== serial.current) return
        setStatus(next)
        setError('')
      },
      (cause) => {
        if (ticket === serial.current) setError(ipcErrorText(cause))
      },
    )
  }, [])
  useEffect(() => {
    const off = window.phosphor.onLocalMachineChanged((next) => {
      serial.current++
      setStatus(next)
      setError('')
    })
    reload()
    return () => {
      serial.current++
      off()
    }
  }, [reload])
  useEffect(() => {
    if (status?.mode !== 'daemon') return
    const timer = window.setInterval(() => {
      if (!document.hidden) reload()
    }, 5000)
    return () => window.clearInterval(timer)
  }, [reload, status?.mode])
  return { status, error, reload }
}

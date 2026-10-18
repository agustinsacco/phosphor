import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { MachineProvider } from '@shared/host-protocol-machine'
import type { Dispatch, SetStateAction } from 'react'
import { useEffect, useRef, useState } from 'react'

export function useProviderSignIn(hostId: string, refresh: number) {
  const platform = usePlatform()
  const live = useRef(true)
  const currentHost = useRef(hostId)
  currentHost.current = hostId
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  // null while the first read is in flight.
  const [providers, setProviders] = useState<MachineProvider[] | null>(null)
  const [terminal, setTerminal] = useState<{ ptyId: string; provider: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const allowed =
    platform.terminal &&
    host?.state === 'ready' &&
    host.capabilities.includes('terminal') &&
    host.capabilities.includes('sessions.control')
  const readable = host?.state === 'ready' && host.capabilities.includes('skills.read')
  useProviderRead(hostId, readable, reload, refresh, setLoadFailed, setProviders)
  useEffect(() => {
    if (!terminal) return
    const id = terminal.ptyId
    const unsubscribe = window.phosphor.onPtyExit(id, () => {
      setTerminal(null)
      void window.phosphor.invoke('hosts:providers', hostId).then(setProviders, () => {
        setError('Could not refresh provider readiness.')
      })
    })
    return () => {
      unsubscribe()
      void window.phosphor.invoke('pty:kill', id).catch(() => undefined)
    }
  }, [terminal, hostId])
  async function start(provider: string) {
    setBusy(true)
    setError(null)
    try {
      const result = await window.phosphor.invoke('hosts:providerLogin', hostId, provider)
      if (live.current && currentHost.current === hostId) setTerminal({ ...result, provider })
      else void window.phosphor.invoke('pty:kill', result.ptyId).catch(() => undefined)
    } catch {
      setError('Sign-in not confirmed. Check readiness before trying again.')
    } finally {
      setBusy(false)
    }
  }
  const claude = terminal?.provider === 'claude'
  return {
    loadFailed,
    setReload,
    readable,
    providers,
    error,
    terminal,
    setTerminal,
    allowed,
    claude,
    busy,
    start,
  }
}
export type ProviderSignInState = ReturnType<typeof useProviderSignIn>

function useProviderRead(
  hostId: string,
  readable: boolean,
  reload: number,
  refresh: number,
  setLoadFailed: Dispatch<SetStateAction<boolean>>,
  setProviders: Dispatch<SetStateAction<MachineProvider[] | null>>,
) {
  useEffect(() => {
    let live = true
    setLoadFailed(false)
    setProviders(null)
    if (readable)
      void window.phosphor.invoke('hosts:providers', hostId).then(
        (rows) => {
          if (live) setProviders(rows)
        },
        () => {
          // A failed read is not "no providers": say so and offer a retry.
          if (live) {
            setProviders([])
            setLoadFailed(true)
          }
        },
      )
    return () => {
      live = false
    }
  }, [hostId, readable, reload, refresh, setLoadFailed, setProviders])
}

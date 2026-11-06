import { useEffect, useState } from 'react'
import type { MachineClaude } from '@shared/host-protocol-machine'

/**
 * A Host's Claude Code detail (`hosts:claude`), read while `enabled` and again
 * whenever `key` changes. `detail` is this Host's last answer: null until one,
 * when the read failed, or when the Host is too old to report it. `loading`
 * holds until the read for this Host and `key` settles.
 */
export function useHostClaude(
  hostId: string,
  key: unknown,
  enabled = true,
): { detail: MachineClaude | null; loading: boolean } {
  const [read, setRead] = useState<{
    hostId: string
    key: unknown
    detail: MachineClaude | null
  } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    const settle = (detail: MachineClaude | null): void => {
      if (live) setRead({ hostId, key, detail })
    }
    window.phosphor.invoke('hosts:claude', hostId).then(settle, () => settle(null))
    return () => {
      live = false
    }
  }, [enabled, hostId, key])
  if (!enabled) return { detail: null, loading: false }
  const mine = read?.hostId === hostId ? read : null
  return { detail: mine?.detail ?? null, loading: mine?.key !== key }
}

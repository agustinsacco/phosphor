import { usePlatform } from '@/platform/Platform'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { errorText } from '@shared/errors'
import type { MachineSettings, MachineSettingsSection } from '@shared/machine-settings'
import { useCallback, useEffect, useRef, useState } from 'react'

export function useHostSettingsSnapshot(
  hostId: string,
  section: MachineSettingsSection,
  repositoryId?: string,
) {
  const supported = usePlatform().machineSettings
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const key = `${hostId}/${generation}/${section}/${repositoryId ?? ''}/${supported}`
  const current = useRef(key)
  current.current = key
  const [result, setResult] = useState<{ key: string; data: MachineSettings } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const allowed =
    supported &&
    connection?.state === 'ready' &&
    connection.configurationSupported === true &&
    connection.capabilities.includes('machine.configure')
  const mounted = useRef(true)
  const attempt = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      attempt.current++
    }
  }, [])
  const refresh = useCallback(async () => {
    if (!mounted.current || current.current !== key || !allowed) return
    const id = ++attempt.current
    setLoading(true)
    setError(null)
    try {
      const data = await window.phosphor.invoke('hosts:settingsRead', hostId, section, repositoryId)
      if (mounted.current && current.current === key && attempt.current === id)
        setResult({ key, data })
    } catch (e) {
      if (mounted.current && current.current === key && attempt.current === id)
        setError(errorText(e))
    } finally {
      if (mounted.current && current.current === key && attempt.current === id) setLoading(false)
    }
  }, [allowed, hostId, section, repositoryId, key])
  useEffect(() => {
    setError(null)
    setResult(null)
    setLoading(false)
    setSaving(false)
    void refresh()
  }, [refresh])
  return {
    supported,
    connection,
    key,
    current,
    result,
    setResult,
    error,
    setError,
    loading,
    setLoading,
    saving,
    setSaving,
    allowed,
    mounted,
    attempt,
    refresh,
  }
}
export type HostSettingsSnapshot = ReturnType<typeof useHostSettingsSnapshot>

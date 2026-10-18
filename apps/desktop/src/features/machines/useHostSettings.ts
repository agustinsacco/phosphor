import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsSection,
} from '@shared/machine-settings'
import { errorText } from '@shared/errors'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineReadGeneration } from '@/stores/machineReadGeneration'

export function useHostSettings(
  hostId: string,
  section: MachineSettingsSection,
  repositoryId?: string,
) {
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const key = `${hostId}/${generation}/${section}/${repositoryId ?? ''}`
  const current = useRef(key)
  current.current = key
  const [result, setResult] = useState<{ key: string; data: MachineSettings } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const allowed =
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
  async function change(change: MachineSettingsChange): Promise<MachineSettings | null> {
    if (!mounted.current || current.current !== key || !allowed || saving || result?.key !== key)
      return null
    setSaving(true)
    setError(null)
    try {
      const data = await window.phosphor.invoke('hosts:settingsPatch', hostId, {
        section,
        repositoryId,
        revision: result.data.revision,
        change,
      })
      if (!mounted.current || current.current !== key) return null
      setResult({ key, data })
      return data
    } catch (e) {
      if (mounted.current && current.current === key) setError(errorText(e))
      return null
    } finally {
      if (mounted.current && current.current === key) setSaving(false)
    }
  }
  async function check(): Promise<void> {
    if (
      !mounted.current ||
      current.current !== key ||
      !allowed ||
      section !== 'connectors' ||
      loading ||
      saving
    )
      return
    const id = ++attempt.current
    setLoading(true)
    setError(null)
    try {
      const data = await window.phosphor.invoke('hosts:settingsCheck', hostId, repositoryId)
      if (mounted.current && current.current === key && attempt.current === id)
        setResult({ key, data })
    } catch (error) {
      if (mounted.current && current.current === key && attempt.current === id)
        setError(errorText(error))
    } finally {
      if (mounted.current && current.current === key && attempt.current === id) setLoading(false)
    }
  }
  async function moveAccount(laneId: string, accountId: string): Promise<void> {
    if (!mounted.current || current.current !== key || !allowed || saving) return
    setSaving(true)
    setError(null)
    let confirmed = false
    try {
      await window.phosphor.invoke('hosts:claudeAccount', hostId, laneId, accountId)
      confirmed = true
    } catch (error) {
      if (mounted.current && current.current === key) setError(errorText(error))
    } finally {
      if (mounted.current && current.current === key) setSaving(false)
    }
    if (confirmed && mounted.current && current.current === key) void refresh()
  }
  return {
    data: result?.key === key ? result.data : null,
    error,
    loading,
    saving,
    allowed,
    connection,
    refresh,
    change,
    check,
    moveAccount,
  }
}
export type HostSettingsState = ReturnType<typeof useHostSettings>

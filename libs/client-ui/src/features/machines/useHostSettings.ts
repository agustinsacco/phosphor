import { errorText } from '@shared/errors'
import type {
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsSection,
} from '@shared/machine-settings'
import { useHostSettingsSnapshot, type HostSettingsSnapshot } from './useHostSettingsSnapshot'

export function useHostSettings(
  hostId: string,
  section: MachineSettingsSection,
  repositoryId?: string,
) {
  const snapshot = useHostSettingsSnapshot(hostId, section, repositoryId)
  const {
    supported,
    connection,
    key,
    current,
    result,
    setResult,
    error,
    setError,
    loading,
    saving,
    setSaving,
    allowed,
    mounted,
    refresh,
  } = snapshot
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
    supported,
    data: result?.key === key ? result.data : null,
    error,
    loading,
    saving,
    allowed,
    connection,
    refresh,
    change,
    check: () => checkHostSettings(snapshot, hostId, section, repositoryId),
    moveAccount,
  }
}
export type HostSettingsState = ReturnType<typeof useHostSettings>

async function checkHostSettings(
  snapshot: HostSettingsSnapshot,
  hostId: string,
  section: MachineSettingsSection,
  repositoryId?: string,
): Promise<void> {
  const {
    mounted,
    current,
    key,
    allowed,
    loading,
    saving,
    attempt,
    setLoading,
    setError,
    setResult,
  } = snapshot
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

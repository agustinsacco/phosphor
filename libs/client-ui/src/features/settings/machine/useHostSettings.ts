import { useCallback, useEffect, useRef, useState } from 'react'
import { usePlatform } from '@/platform/Platform'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { errorText } from '@shared/errors'
import type { HostConnectionView } from '@shared/ipc'
import type {
  MachineSettings,
  MachineSettingsChange,
  MachineSettingsSection,
} from '@shared/machine-settings'

/** This client may read and change the Host's settings over this connection. */
export const canConfigureHost = (
  supported: boolean,
  connection: HostConnectionView | undefined,
): boolean =>
  supported &&
  connection?.state === 'ready' &&
  connection.configurationSupported === true &&
  connection.capabilities.includes('machine.configure')

interface SettingsState {
  result: { key: string; data: MachineSettings } | null
  error: string | null
  loading: boolean
  saving: boolean
  /** A connectors check is in flight; `loading` is true for any read. */
  checking: boolean
}
const IDLE: SettingsState = {
  result: null,
  error: null,
  loading: false,
  saving: false,
  checking: false,
}

interface Writer {
  /** Still mounted, on the same connection generation, section and scope. */
  live: () => boolean
  saving: boolean
  update: (patch: Partial<SettingsState>) => void
}

/** One write at a time; `apply` sees its result only while the section is still the same. */
async function write<T>(
  { live, saving, update }: Writer,
  request: () => Promise<T>,
  apply: (value: T) => void,
): Promise<{ value: T } | null> {
  if (!live() || saving) return null
  update({ saving: true, error: null })
  try {
    const value = await request()
    if (!live()) return null
    apply(value)
    return { value }
  } catch (e) {
    if (live()) update({ error: errorText(e) })
    return null
  } finally {
    if (live()) update({ saving: false })
  }
}

/** `live()`: still mounted and still on `key`. Unmounting also retires every read in flight. */
function useLive(key: string) {
  const current = useRef(key)
  current.current = key
  const mounted = useRef(true)
  const attempt = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      attempt.current++
    }
  }, [])
  const live = useCallback(() => mounted.current && current.current === key, [key])
  return { live, attempt }
}

/**
 * One Host settings section, for `repositoryId` or the whole machine. A read,
 * check or change belongs to the connection generation, section and scope it
 * started in: one that completes after they changed, or after unmount, is
 * dropped, and of overlapping reads only the newest lands.
 */
export function useHostSettings(
  hostId: string,
  /** Null for a section that reads no settings: nothing is read. */
  section: MachineSettingsSection | null,
  repositoryId?: string,
) {
  const supported = usePlatform().machineSettings
  const connection = useRemoteLanesStore((s) => s.hosts[hostId])
  const generation = useRemoteLanesStore(() => machineReadGeneration(hostId))
  const key = `${hostId}/${generation}/${section ?? ''}/${repositoryId ?? ''}/${supported}`
  const allowed = canConfigureHost(supported, connection)
  const { live, attempt } = useLive(key)
  const [state, setState] = useState(IDLE)
  const update = useCallback(
    (patch: Partial<SettingsState>) => setState((s) => ({ ...s, ...patch })),
    [],
  )
  const read = useCallback(
    async (request: () => Promise<MachineSettings>): Promise<void> => {
      if (!live() || !allowed) return
      const id = ++attempt.current
      const latest = () => live() && attempt.current === id
      update({ loading: true, error: null })
      try {
        const data = await request()
        if (latest()) update({ result: { key, data } })
      } catch (e) {
        if (latest()) update({ error: errorText(e) })
      } finally {
        if (latest()) update({ loading: false })
      }
    },
    [live, allowed, attempt, key, update],
  )
  const refresh = useCallback(async (): Promise<void> => {
    if (section)
      await read(() => window.phosphor.invoke('hosts:settingsRead', hostId, section, repositoryId))
  }, [read, hostId, section, repositoryId])
  useEffect(() => {
    setState(IDLE)
    void refresh()
  }, [refresh])
  const data = state.result?.key === key ? state.result.data : null
  const writer: Writer = { live, saving: state.saving, update }
  return {
    supported,
    data,
    error: state.error,
    loading: state.loading,
    saving: state.saving,
    checking: state.checking,
    allowed,
    connection,
    refresh,
    change: async (change: MachineSettingsChange): Promise<MachineSettings | null> => {
      if (!data || !allowed || !section) return null
      const patch = { section, repositoryId, revision: data.revision, change }
      const saved = await write(
        writer,
        () => window.phosphor.invoke('hosts:settingsPatch', hostId, patch),
        (next) => update({ result: { key, data: next } }),
      )
      return saved?.value ?? null
    },
    check: async (): Promise<void> => {
      if (section !== 'connectors' || state.loading || state.saving) return
      update({ checking: true })
      try {
        await read(() => window.phosphor.invoke('hosts:settingsCheck', hostId, repositoryId))
      } finally {
        if (live()) update({ checking: false })
      }
    },
    moveAccount: async (laneId: string, accountId: string): Promise<void> => {
      if (!allowed) return
      const moved = await write(
        writer,
        () => window.phosphor.invoke('hosts:claudeAccount', hostId, laneId, accountId),
        () => undefined,
      )
      if (moved) void refresh()
    },
  }
}
export type HostSettingsState = ReturnType<typeof useHostSettings>

import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import { usePlatform } from '@/platform/Platform'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { installedExtensionTabs, type EXTENSION_TABS, type MachineKind } from '../../settingsIndex'
import { useSettingsUiStore, type SettingsMachine } from '../../settingsUiStore'
import { canConfigureHost } from '../../machine/useHostSettings'
import { useLocalRead } from '../../machine/ScopeRefresh'
import { SETTINGS_SECTIONS } from '../registry'
import {
  packageListKey,
  publishPackageList,
  useExtensionPackageLists,
} from './extensionPackageLists'

type ExtensionTabs = typeof EXTENSION_TABS

/**
 * The extension items nested under Extensions for the chosen machine. An item
 * is listed when the section registry has a view for that kind of machine and
 * it is `always` listed or its package is there, declared or installed
 * (`requiresInstalled` needs installed), in the scope line's folder. Every
 * machine reads its packages in that scope and lists only a read of it.
 */
export function useExtensionTabs(machine: SettingsMachine | null): ExtensionTabs {
  const kind: MachineKind | null = machine ? (machine === 'local' ? 'local' : 'host') : null
  const folder = useSettingsUiStore((s) => s.folder)
  useLocalPackageRead(kind === 'local', folder)
  useHostPackageRead(kind === 'host' ? machine : null, folder)
  const packages = useExtensionPackageLists((s) =>
    machine ? s[packageListKey(machine, folder)] : undefined,
  )
  return useMemo(() => {
    if (!kind) return []
    const view = kind === 'local' ? 'Local' : 'Host'
    return installedExtensionTabs(packages ?? []).filter((tab) => !!SETTINGS_SECTIONS[tab.id][view])
  }, [kind, packages])
}

/**
 * This Mac's packages in the scope line's folder: read once per scope and on
 * Refresh, then whatever the Extensions page reads after a job.
 */
function useLocalPackageRead(enabled: boolean, folder: string | null): void {
  const latest = useRef(0)
  const read = useCallback(async (): Promise<void> => {
    if (!enabled) return
    const call = ++latest.current
    const entries = await window.phosphor
      .invoke('packages:list', folder ?? undefined)
      .catch(() => [])
    // Only the newest read publishes, as a Refresh mid-read supersedes it.
    if (call === latest.current) publishPackageList('local', folder, entries)
  }, [enabled, folder])
  useLocalRead(read)
}

/**
 * A Host's packages in the scope line's folder: read once per connection and
 * scope while configuration access is granted, then whatever the Extensions
 * page reads after a task.
 */
function useHostPackageRead(hostId: string | null, folder: string | null): void {
  const supported = usePlatform().machineSettings
  const connection = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const allowed = canConfigureHost(supported, connection)
  // A layout effect: the navigation's read goes out before the open section's own.
  useLayoutEffect(() => {
    if (!hostId || !allowed) return
    let cancelled = false
    window.phosphor
      .invoke('hosts:settingsRead', hostId, 'resources', folder ?? undefined)
      .then((read) => {
        if (!cancelled && read.resources)
          publishPackageList(hostId, folder, read.resources.packages)
      })
      // Without the list a Host lists only the items that need no package.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hostId, allowed, generation, folder])
}

import { useEffect, useLayoutEffect, useMemo, useState } from 'react'
import { usePlatform } from '@/platform/Platform'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { installedExtensionTabs, type EXTENSION_TABS, type MachineKind } from '../../settingsIndex'
import { useSettingsUiStore, type SettingsMachine } from '../../settingsUiStore'
import { SETTINGS_SECTIONS } from '../registry'
import { publishHostPackages, useHostExtensionPackages } from './hostExtensionPackages'

type ExtensionTabs = typeof EXTENSION_TABS

/**
 * The extension items nested under Extensions for the chosen machine. An item
 * is listed when the section registry has a view for that kind of machine and
 * it is `always` listed or its package is there: declared or installed on This
 * Mac (`requiresInstalled` needs installed), installed on a Host.
 */
export function useExtensionTabs(machine: SettingsMachine | null): ExtensionTabs {
  const kind: MachineKind | null = machine ? (machine === 'local' ? 'local' : 'host') : null
  const local = useLocalPackageTabs(kind === 'local')
  const host = useHostPackageTabs(kind === 'host' ? machine : null)
  return useMemo(() => {
    if (!kind) return []
    const view = kind === 'local' ? 'Local' : 'Host'
    return (kind === 'local' ? local : host).filter((tab) => !!SETTINGS_SECTIONS[tab.id][view])
  }, [kind, local, host])
}

/**
 * This Mac's packages in the scope line's folder, as the Extensions page lists
 * them, read again whenever the tab changes: installing from Extensions shows
 * the package's own item without reopening Settings.
 */
function useLocalPackageTabs(enabled: boolean): ExtensionTabs {
  const tab = useSettingsUiStore((s) => s.tab)
  const folder = useSettingsUiStore((s) => s.folder)
  const [tabs, setTabs] = useState<ExtensionTabs>(() => installedExtensionTabs([]))
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    window.phosphor
      .invoke('packages:list', folder ?? undefined)
      .then((entries) => {
        if (!cancelled) setTabs(installedExtensionTabs(entries))
      })
      .catch(() => {
        if (!cancelled) setTabs(installedExtensionTabs([]))
      })
    return () => {
      cancelled = true
    }
  }, [enabled, tab, folder])
  return tabs
}

/**
 * A Host's installed packages: read once per connection while configuration
 * access is granted, then whatever the Extensions page reads after a task.
 */
function useHostPackageTabs(hostId: string | null): ExtensionTabs {
  const supported = usePlatform().machineSettings
  const connection = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const packages = useHostExtensionPackages((s) => (hostId ? s[hostId] : undefined))
  const allowed =
    supported &&
    connection?.state === 'ready' &&
    connection.configurationSupported === true &&
    connection.capabilities.includes('machine.configure')
  // A layout effect: the navigation's read goes out before the open section's own.
  useLayoutEffect(() => {
    if (!hostId || !allowed) return
    let cancelled = false
    window.phosphor
      .invoke('hosts:settingsRead', hostId, 'resources')
      .then((read) => {
        if (!cancelled && read.resources) publishHostPackages(hostId, read.resources.packages)
      })
      // Without the list a Host lists only the items that need no package.
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [hostId, allowed, generation])
  return useMemo(
    () => installedExtensionTabs((packages ?? []).filter((pkg) => pkg.installed)),
    [packages],
  )
}

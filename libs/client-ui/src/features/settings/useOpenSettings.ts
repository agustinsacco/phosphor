import { useCallback } from 'react'
import { useNavigation } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { useSettingsUiStore, type SettingsMachine, type SettingsTab } from './settingsUiStore'

/**
 * Settings on `tab`, configuring `machine` (null: the default machine). The
 * one way in for every link that names a section or a machine: Desktop opens
 * its dialog, the browser goes to `/pages/settings/<machine>`.
 */
export function openSettings(
  navigate: (next: Location) => void,
  machine: SettingsMachine | null,
  tab: SettingsTab,
): void {
  useSettingsUiStore.getState().setTab(tab)
  navigate({ to: 'page', page: 'settings', ...(machine ? { machine } : {}) })
}

/** `openSettings` through this shell's navigation. */
export function useOpenSettings(): (machine: SettingsMachine | null, tab: SettingsTab) => void {
  const { navigate } = useNavigation()
  return useCallback(
    (machine: SettingsMachine | null, tab: SettingsTab) => openSettings(navigate, machine, tab),
    [navigate],
  )
}

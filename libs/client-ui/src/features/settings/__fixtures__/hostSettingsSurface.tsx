import { act } from 'react'
import type { Root } from 'react-dom/client'
import type { MachineView } from '@shared/control-api'
import { DESKTOP_PLATFORM, PlatformProvider, type Platform } from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { SettingsSurface } from '../SettingsSurface'
import { useSettingsUiStore, type SettingsTab } from '../settingsUiStore'

/** Desktop without the feedback footer, whose state read would add an IPC call. */
export const HOST_SETTINGS_PLATFORM: Platform = { ...DESKTOP_PLATFORM, feedback: false }

/** Lists the Host as a known machine; jsdom has no element scrolling. */
export function prepareHostSettings(machine: { id: string; label: string }): void {
  useMachinesStore.setState({
    machines: [{ id: machine.id, label: machine.label } as MachineView],
    view: { kind: 'list' },
  })
  if (!HTMLElement.prototype.scrollTo)
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: () => undefined,
    })
}

/** The shared Settings surface on `tab`, configuring the Host `hostId`. */
export async function showHostSettings(
  root: Root,
  hostId: string,
  tab: SettingsTab,
  platform: Platform = HOST_SETTINGS_PLATFORM,
): Promise<void> {
  useSettingsUiStore.setState({ tab, machine: hostId, query: '', listing: false, reveal: null })
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <SettingsSurface />
      </PlatformProvider>,
    ),
  )
}

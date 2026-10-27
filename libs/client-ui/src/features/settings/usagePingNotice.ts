import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from './settingsUiStore'
import { readUsagePing } from './tabs/UsagePingSection'

const NOTICE_MS = 20_000
export const USAGE_PING_ROW = 'Send an anonymous daily usage ping'

/**
 * Once ever, before the first ping: say what the ping is and offer the switch.
 * Main sends nothing until this has been shown, so the notice always comes
 * first. Silent where nothing would be sent: the browser, dev builds,
 * DO_NOT_TRACK, or a switch already turned off.
 */
export async function noticeUsagePing(): Promise<void> {
  const state = await readUsagePing()
  if (!state || state.noticeShown || !state.enabled || state.blocked) return
  useExtensionUiStore.getState().notify({
    kind: 'info',
    title: 'Anonymous usage ping',
    message:
      'Once a day Phosphor sends its version, OS and architecture, with no ID, so we can ' +
      'count active installs. See exactly what is sent, or turn it off.',
    openLabel: 'Open privacy settings',
    durationMs: NOTICE_MS,
    onOpen: () => {
      const settings = useSettingsUiStore.getState()
      settings.setOpen(true)
      settings.openResult('advanced', USAGE_PING_ROW)
    },
  })
  await window.phosphor.invoke('app:setUsagePing', { noticeShown: true }).catch(() => undefined)
}

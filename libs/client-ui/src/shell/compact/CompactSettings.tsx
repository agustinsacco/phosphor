import { useEffect } from 'react'
import { PageShell } from '@/components/PageShell'
import { PageBody } from '@/components/PageBody'
import { SettingsSurface } from '@/features/settings/SettingsSurface'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { NotificationsButton } from '@/features/notifications/NotificationsButton'
import { usePlatform } from '@/platform/Platform'

/** The browser's Settings page: the shared surface in a page. */
export function CompactSettings({ machine }: { machine?: string }): React.JSX.Element {
  const compact = usePlatform().formFactor === 'compact'
  // Each arrival starts unsearched on the default machine, as opening the Desktop dialog does.
  useEffect(() => useSettingsUiStore.getState().reset(), [machine])
  return (
    <PageShell title="Settings" actions={compact ? <NotificationsButton /> : undefined}>
      <PageBody layout="fill">
        <SettingsSurface fallbackMachine={machine} />
      </PageBody>
    </PageShell>
  )
}

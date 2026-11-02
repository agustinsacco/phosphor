import type { WebAccessKey } from '@shared/web-access'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useHostSection } from '../../machine/HostSection'
import type { WebAccessSource } from './webAccessSource'

/**
 * A Host's `web-search.json`, from its `resources` read: key names only. A
 * Host too old to report them gets no fields, only the update notice.
 */
export function useHostWebAccess(): WebAccessSource {
  const { machine, settings } = useHostSection()
  const webAccess = settings.data?.resources?.webAccess
  const set = async (key: WebAccessKey, value: string | null): Promise<void> => {
    const saved = await settings.change({ type: 'webAccess.key', key, value })
    if (saved)
      useExtensionUiStore
        .getState()
        .pushToast(`Saved on ${machine.label} — applies to new lanes`, 'info')
  }
  return {
    caps: { rawEditor: false },
    configured: webAccess?.configured ?? null,
    malformed: webAccess?.malformed === true,
    path: null,
    notice: webAccess
      ? null
      : {
          tone: 'info',
          title: 'Update this Host to configure Web access',
          body: 'This Host’s version does not report its search provider keys. Run phosphor update on it.',
        },
    busy: settings.loading || settings.saving,
    set: (key, value) => void set(key, value),
    refresh: () => void settings.refresh(),
  }
}

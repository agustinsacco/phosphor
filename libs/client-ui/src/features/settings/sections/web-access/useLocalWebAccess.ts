import { useCallback, useEffect, useState } from 'react'
import { errorText } from '@shared/errors'
import type { WebAccessConfigState, WebAccessKey } from '@shared/web-access'
import { useExtensionUiStore } from '@/stores/extensionUi'
import type { WebAccessSource } from './webAccessSource'
import { useOnLocalRefresh } from '../../machine/ScopeRefresh'

/** This Mac's `web-search.json`: main reports key names, never values, and saves it 0600. */
export function useLocalWebAccess(): WebAccessSource {
  const [state, setState] = useState<WebAccessConfigState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      setState(await window.phosphor.invoke('pi:webSearchConfig'))
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])
  useOnLocalRefresh(refresh)

  const set = async (key: WebAccessKey, value: string | null): Promise<void> => {
    setBusy(true)
    try {
      await window.phosphor.invoke('pi:patchWebSearchConfig', { [key]: value ?? undefined })
      useExtensionUiStore.getState().pushToast('Saved — applies to new sessions', 'info')
      await refresh()
    } catch (err) {
      useExtensionUiStore.getState().pushToast(errorText(err), 'error')
    } finally {
      setBusy(false)
    }
  }

  return {
    status: error ? { error, retry: () => void refresh() } : state ? 'ready' : 'loading',
    caps: { rawEditor: true },
    configured: state?.configured ?? null,
    malformed: state?.malformed === true,
    path: state?.path ?? null,
    busy,
    set: (key, value) => void set(key, value),
    refresh: () => void refresh(),
  }
}

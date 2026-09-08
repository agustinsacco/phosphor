import { useCallback, useEffect, useState } from 'react'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { Button } from '@/components/form'
import { ConfigFileEditor, piConfigFile } from '../ConfigFileEditor'
import { errorText } from '@shared/errors'

/**
 * Search providers surfaced as first-class fields. pi-web-access supports
 * many more (see its README); everything else is reachable via the raw
 * editor. Keys verified against pi-web-access 0.24.0.
 */
const PROVIDERS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'braveApiKey', label: 'Brave Search', hint: 'BSA_…' },
  { key: 'tavilyApiKey', label: 'Tavily', hint: 'tvly-…' },
  { key: 'exaApiKey', label: 'Exa', hint: 'exa-…' },
  { key: 'jinaApiKey', label: 'Jina Reader', hint: 'jina_…' },
  { key: 'kagiApiKey', label: 'Kagi', hint: '' },
  { key: 'serperApiKey', label: 'Serper', hint: '' },
  { key: 'openaiApiKey', label: 'OpenAI (search + summaries)', hint: 'sk-…' },
]

/**
 * Settings → Web access: config for the pi-web-access package
 * (web-search.json). Shown only while the package is present.
 */
export function WebAccessTab(): React.JSX.Element {
  const [state, setState] = useState<{
    path: string
    exists: boolean
    malformed: boolean
    error?: string
    config: Record<string, unknown>
  } | null>(null)
  const [rawEdit, setRawEdit] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setState(await window.phosphor.invoke('pi:webSearchConfig'))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const patch = async (key: string, value: string): Promise<void> => {
    try {
      await window.phosphor.invoke('pi:patchWebSearchConfig', { [key]: value || undefined })
      useExtensionUiStore.getState().pushToast('Saved — applies to new sessions', 'info')
      await refresh()
    } catch (error) {
      useExtensionUiStore.getState().pushToast(errorText(error), 'error')
    }
  }

  const configured = (key: string): boolean => {
    const value = state?.config[key]
    return typeof value === 'string' && value.length > 0
  }

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Web access</h2>
      <p className="text-text-secondary mt-1 text-base">
        Search, fetching and PDF extraction for sessions, provided by{' '}
        <span className="font-mono">pi-web-access</span>. Every provider is optional — configure the
        ones you have keys for. Values support <span className="font-mono">$ENV_VAR</span>{' '}
        interpolation.
      </p>

      {state?.malformed && (
        <div className="bg-danger-soft border-danger/30 mt-4 rounded-lg border px-3.5 py-3 text-base">
          <span className="text-danger font-medium">
            {state.path} is not valid JSON{state.error ? ` (${state.error})` : ''}.
          </span>{' '}
          <span className="text-text-secondary">
            Field editing is disabled so Phosphor cannot clobber it — fix it in the raw editor.
          </span>
        </div>
      )}

      <h3 className="mt-5 text-lg font-semibold">Search providers</h3>
      <div className="border-border mt-2 divide-y rounded-lg border">
        {PROVIDERS.map((provider) => (
          <ProviderRow
            key={provider.key}
            label={provider.label}
            hint={provider.hint}
            configured={configured(provider.key)}
            disabled={state?.malformed === true}
            onCommit={(value) => void patch(provider.key, value)}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={() => setRawEdit(true)}>Edit raw JSON…</Button>
        <span className="text-text-tertiary font-mono text-sm">{state?.path ?? ''}</span>
      </div>
      <p className="text-text-tertiary mt-3 text-sm">
        More providers (SearXNG, Firecrawl, BrightData, …) and base-URL overrides are available in
        the raw file — see the package docs. Keys are stored locally in this file.
      </p>

      {rawEdit && (
        <ConfigFileEditor
          source={piConfigFile('web-search')}
          onClose={() => {
            setRawEdit(false)
            void refresh()
          }}
        />
      )}
    </div>
  )
}

function ProviderRow({
  label,
  hint,
  configured,
  disabled,
  onCommit,
}: {
  label: string
  hint: string
  configured: boolean
  disabled: boolean
  onCommit: (value: string) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')

  const commit = (): void => {
    onCommit(value.trim())
    setEditing(false)
    setValue('')
  }

  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0">
        <div className="text-base font-medium">{label}</div>
        <div className="text-text-tertiary text-sm">
          {configured ? 'configured' : 'not configured'}
        </div>
      </div>
      {editing ? (
        <div className="flex items-center gap-2">
          <input
            autoFocus
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
            placeholder={hint || 'API key or $ENV_VAR'}
            className="border-border bg-bg-secondary focus:border-accent w-56 rounded-md border px-2.5 py-1.5 font-mono text-base outline-none"
          />
          <Button variant="primary" onClick={commit}>
            Save
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => setEditing(true)} disabled={disabled}>
            {configured ? 'Replace' : 'Set key'}
          </Button>
          {configured && (
            <button
              onClick={() => onCommit('')}
              disabled={disabled}
              className="text-danger hover:bg-danger-soft rounded-md px-2 py-1 text-sm font-medium transition-colors disabled:opacity-50"
            >
              Clear
            </button>
          )}
        </div>
      )}
    </div>
  )
}

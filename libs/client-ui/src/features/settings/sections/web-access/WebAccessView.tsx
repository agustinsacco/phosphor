import { useState } from 'react'
import { Button, SettingsNotice, TextInput } from '@/components/form'
import { WEB_ACCESS_PROVIDERS } from '@shared/web-access'
import { ConfigFileEditor, piConfigFile } from '../../ConfigFileEditor'
import { SectionStatusNotice } from '../sectionStatus'
import type { WebAccessSource } from './webAccessSource'

/**
 * Settings → Web access on every machine: the search provider keys of the
 * pi-web-access package. A key is set or replaced by value and cleared; the
 * machine reports only which keys are set, never their values.
 */
export function WebAccessView({ source }: { source: WebAccessSource }): React.JSX.Element {
  const { configured, malformed, notice } = source
  const [rawEdit, setRawEdit] = useState(false)
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Web access</h2>
      <p className="text-text-secondary mt-1 text-base">
        Search, fetching and PDF extraction for sessions, provided by{' '}
        <span className="font-mono">pi-web-access</span>. Every provider is optional — configure the
        ones you have keys for. Values support <span className="font-mono">$ENV_VAR</span>{' '}
        interpolation. Changes apply to new sessions.
      </p>
      <div className="mt-4 empty:hidden">
        <SectionStatusNotice status={source.status} title="Could not read web-search.json" />
        {notice && <SettingsNotice {...notice} />}
      </div>
      {malformed && (
        <div className="mt-4">
          <SettingsNotice
            tone="danger"
            title={`${source.path ?? 'web-search.json'} is not valid JSON.`}
            body={
              source.caps.rawEditor
                ? 'Field editing is disabled so Phosphor cannot clobber it — fix it in the raw editor.'
                : 'Field editing is disabled so Phosphor cannot clobber it — fix the file on the machine.'
            }
          />
        </div>
      )}

      {configured && (
        <>
          <h3 className="mt-5 text-lg font-semibold">Search providers</h3>
          <div className="border-border divide-border mt-2 divide-y rounded-lg border">
            {WEB_ACCESS_PROVIDERS.map((provider) => (
              <ProviderRow
                key={provider.key}
                label={provider.label}
                hint={provider.hint}
                configured={configured.includes(provider.key)}
                disabled={malformed || source.busy}
                onCommit={(value) => source.set(provider.key, value)}
              />
            ))}
          </div>
        </>
      )}

      {source.caps.rawEditor && (
        <div className="mt-4 flex items-center gap-3">
          <Button onClick={() => setRawEdit(true)}>Edit raw JSON…</Button>
          <span className="text-text-tertiary font-mono text-sm">{source.path ?? ''}</span>
        </div>
      )}
      <p className="text-text-tertiary mt-3 text-sm">
        More providers (SearXNG, Firecrawl, BrightData, …) and base-URL overrides are set in the
        file itself — see the package docs. Keys are stored in this file on the machine.
      </p>

      {rawEdit && (
        <ConfigFileEditor
          source={piConfigFile('web-search')}
          onClose={() => {
            setRawEdit(false)
            source.refresh()
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
  /** A value sets the key; null clears it. */
  onCommit: (value: string | null) => void
}): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const commit = (): void => {
    onCommit(value.trim() || null)
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
          <TextInput
            autoFocus
            type="password"
            aria-label={`${label} key`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') setEditing(false)
            }}
            placeholder={hint || 'API key or $ENV_VAR'}
            className="w-56 font-mono"
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
            <Button
              size="sm"
              className="text-danger"
              onClick={() => onCommit(null)}
              disabled={disabled}
            >
              Clear
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

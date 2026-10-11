import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { piInstallLocation, type PiHealth } from '@shared/models'
import type { PiResources } from '@shared/models'
import { ConfigFileEditor, piConfigFile } from '../ConfigFileEditor'
import { MaintenanceSection } from './MaintenanceSection'
import { ipcErrorText } from '@shared/errors'
import { useAccount } from '../useAccount'

/** pi install health, discovered resources, and raw config file editing. */

export function AdvancedTab(): React.JSX.Element {
  const [health, setHealth] = useState<PiHealth | null>(null)
  const [resources, setResources] = useState<PiResources | null>(null)
  const [editing, setEditing] = useState<'settings' | 'models' | null>(null)
  const [account, setAccount] = useAccount()
  // One change at a time: turning it off waits for the sign-out, and a quick
  // second click must not land first and then be overwritten.
  const [previewBusy, setPreviewBusy] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const togglePreview = (on: boolean): void => {
    setPreviewBusy(true)
    setPreviewError(null)
    window.phosphor
      .invoke('account:setPreview', on)
      .then(setAccount, (caught: unknown) => setPreviewError(ipcErrorText(caught)))
      .finally(() => setPreviewBusy(false))
  }

  useEffect(() => {
    void window.phosphor.invoke('pi:health').then(setHealth)
    void window.phosphor.invoke('pi:listResources').then(setResources)
  }, [])

  return (
    <div>
      <SectionTitle>Advanced</SectionTitle>

      <Row
        title="pi health"
        description={
          health
            ? `${piInstallLocation(health) ?? 'not found'} — minimum supported ${health.minVersion}`
            : 'checking…'
        }
      >
        <span
          className={clsx(
            'rounded-md px-2 py-1 font-mono text-sm font-medium',
            health?.ok ? 'bg-success/15 text-success' : 'bg-danger-soft text-danger',
          )}
        >
          {health ? (health.ok ? `v${health.version}` : (health.reason ?? 'error')) : '…'}
        </span>
      </Row>

      <Row
        title="pi settings.json"
        description="Raw editor for ~/.pi/agent/settings.json. Restart sessions to apply."
      >
        <Button onClick={() => setEditing('settings')}>Edit…</Button>
      </Row>
      <Row
        title="pi models.json"
        description="Custom providers and models (local endpoints live here)."
      >
        <Button onClick={() => setEditing('models')}>Edit…</Button>
      </Row>

      <Row
        title="Phosphor account (preview)"
        description="Shows an optional GitHub sign-in under Accounts. It does nothing else yet; your machines come later. Turning it off signs you out."
      >
        <Toggle
          on={account?.preview ?? false}
          disabled={account === null || previewBusy}
          onChange={togglePreview}
        />
      </Row>
      {previewError && <p className="text-danger -mt-1 mb-2 text-sm">{previewError}</p>}

      <MaintenanceSection />

      <SectionTitle small>
        Local pi resources (loose files — packages are in the Extensions tab; skills have their own
        page: sidebar → Skills)
      </SectionTitle>
      <div className="grid grid-cols-3 gap-3">
        {(['extensions', 'prompts', 'themes'] as const).map((kind) => (
          <div key={kind} className="border-border bg-surface rounded-xl border p-3">
            <div className="text-text-tertiary text-xs font-semibold font-mono uppercase tracking-wider">
              {kind}
            </div>
            <div className="mt-1.5 space-y-0.5">
              {(resources?.[kind] ?? []).slice(0, 8).map((name) => (
                <div key={name} className="truncate font-mono text-sm">
                  {name}
                </div>
              ))}
              {resources && resources[kind].length === 0 && (
                <div className="text-text-tertiary text-sm">none</div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="text-text-tertiary mt-3 text-sm">
        auth.json is never read or displayed by Phosphor.
      </p>

      {editing && (
        <ConfigFileEditor source={piConfigFile(editing)} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

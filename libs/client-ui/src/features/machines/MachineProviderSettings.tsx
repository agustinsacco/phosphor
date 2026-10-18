import type { ProviderLoginOp } from '@shared/host-protocol-providers'
import type { MachineTaskOp } from '@shared/machine-settings'
import { useState } from 'react'
import { ClaudeAccounts } from './MachineClaudeAccounts'
import { ClaudeSetup, OtherProviders } from './MachineProviderSections'
import type { HostSettingsState } from './useHostSettings'

export interface MachinePrograms {
  login(provider: string, account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount'>): void
  task(op: Omit<MachineTaskOp, 'type'>): void
  busy: boolean
  available: boolean
}
export function MachineProviderSettings({
  hostId,
  label,
  settings,
  programs,
}: {
  hostId: string
  label: string
  settings: HostSettingsState
  programs: MachinePrograms
}): React.JSX.Element | null {
  const [expanded, setExpanded] = useState<string | null>(null)
  const state = settings.data?.providers
  if (!state) return null
  const busy = settings.saving || settings.loading || programs.busy || state.authenticating
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Providers</h2>
        <p className="text-text-secondary mt-1 text-base">
          Accounts that run models on {label}. Credentials stay on that machine.
        </p>
      </div>
      <ClaudeSetup {...{ hostId, label, settings, programs, state, busy }} />
      <ClaudeAccounts
        {...{ hostId, label, settings, programs, state, busy, expanded, setExpanded }}
      />
      <OtherProviders {...{ hostId, label, settings, programs, state, busy }} />
    </div>
  )
}

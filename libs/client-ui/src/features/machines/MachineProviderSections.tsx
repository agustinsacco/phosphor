import { Button } from '@/components/form'
import type { MachineSettings } from '@shared/machine-settings'
import type { MachinePrograms } from './MachineProviderSettings'
import { Card, StatusPill } from './MachineUi'
import type { HostSettingsState } from './useHostSettings'
export interface ProviderSectionProps {
  hostId: string
  label: string
  settings: HostSettingsState
  programs: MachinePrograms
  state: NonNullable<MachineSettings['providers']>
  busy: boolean
}

export function ClaudeSetup({
  state,
  label,
  programs,
  busy,
}: ProviderSectionProps): React.JSX.Element {
  return (
    <Card title="Claude Code setup">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-medium">pi Claude provider</h3>
            <p className="text-text-secondary text-base">
              @saccolabs/pi-claude-cli · required version or newer
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill tone={state.claude.provider === 'ok' ? 'ok' : 'warn'}>
              {state.claude.provider === 'ok' ? 'Installed' : state.claude.provider}
            </StatusPill>
            {state.claude.provider !== 'ok' && (
              <Button
                size="xs"
                disabled={busy || !programs.available}
                onClick={() => programs.task({ task: 'claude.installProvider' })}
              >
                {state.claude.provider === 'outdated' ? 'Update provider' : 'Install provider'}
              </Button>
            )}
          </div>
        </div>
        <div className="border-border flex flex-wrap items-center justify-between gap-3 border-t pt-3">
          <div>
            <h3 className="text-lg font-medium">Claude Code CLI</h3>
            <p className="text-text-secondary text-base">
              Installed on {label}, not this computer.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <StatusPill tone={state.claude.cli === 'ok' ? 'ok' : 'warn'}>
              {state.claude.cli === 'ok' ? 'Installed' : 'Missing'}
            </StatusPill>
            {state.claude.cli !== 'ok' && (
              <Button
                size="xs"
                disabled={busy || !programs.available}
                onClick={() => programs.task({ task: 'claude.installCli' })}
              >
                Install Claude Code
              </Button>
            )}
          </div>
        </div>
      </div>
      <p className="text-text-tertiary mt-3 text-sm">
        Installing a provider or CLI runs code on {label}. You review the destination and command
        before it starts. Existing lanes are not restarted.
      </p>
    </Card>
  )
}

export function OtherProviders({ state, programs, busy }: ProviderSectionProps): React.JSX.Element {
  return (
    <Card title="Other providers">
      <ul className="divide-border divide-y">
        {state.providers
          .filter((p) => !['claude', 'pi-claude-cli'].includes(p.id))
          .map((provider) => (
            <li
              key={provider.id}
              data-provider={provider.id}
              className="flex flex-wrap items-center gap-3 py-2"
            >
              <span className="min-w-0 flex-1 text-lg">{provider.name}</span>
              <StatusPill tone={provider.status === 'ready' ? 'ok' : 'off'}>
                {provider.status === 'ready'
                  ? 'Ready'
                  : provider.status === 'not_ready'
                    ? 'Not signed in'
                    : 'Not reported'}
              </StatusPill>
              <Button
                size="xs"
                disabled={busy || !programs.available}
                onClick={() => programs.login(provider.id)}
              >
                {provider.status === 'ready' ? 'Manage sign-in' : 'Sign in'}
              </Button>
            </li>
          ))}
      </ul>
      <p className="text-text-tertiary mt-3 text-sm">
        pi owns these provider credentials. Its terminal supports the provider’s available login
        flow. API-key or environment-only providers may require configuration on the Host instead.
      </p>
    </Card>
  )
}

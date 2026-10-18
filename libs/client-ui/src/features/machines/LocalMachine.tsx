import { usePlatform } from '@/platform/Platform'
import { useEffect, useState } from 'react'
import type { ClaudeStatus, PiHealth, SubscriptionProviderStatus } from '@shared/models'
import { Button } from '@/components/form'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useSessionsStore } from '@/stores/sessions'
import { Card, CheckRow, Fact, Facts, Skeleton, StatusPill, type CheckItem } from './MachineUi'
import { localMachineLabel, PI_INSTALL, platformName } from './machinePresentation'

/** Each read is `undefined` until it settles; a settled read can still be empty. */
export interface Computer {
  health?: PiHealth | null
  claude?: ClaudeStatus | null
  providers?: SubscriptionProviderStatus[] | null
  error: boolean
}

/** This computer's own readiness: pi, the Claude CLI and subscription sign-ins. */
export function useThisComputer(): Computer {
  const { localLanes } = usePlatform()
  const [state, setState] = useState<Computer>({ error: false })
  useEffect(() => {
    if (!localLanes) return
    let live = true
    const merge = (patch: Partial<Computer>): void => {
      if (live) setState((current) => ({ ...current, ...patch }))
    }
    void window.phosphor.invoke('pi:health').then(
      (health) => merge({ health }),
      () => merge({ error: true }),
    )
    void window.phosphor.invoke('packages:claudeStatus').then(
      (claude) => merge({ claude }),
      () => merge({ error: true }),
    )
    void window.phosphor.invoke('pi:subscriptionAuth').then(
      (providers) => merge({ providers }),
      () => merge({ error: true, providers: [] }),
    )
    return () => {
      live = false
    }
  }, [localLanes])
  return state
}

export function localChecks(computer: Computer): CheckItem[] {
  const { health, claude } = computer
  return [
    {
      name: 'pi',
      ok: health?.ok === true,
      loading: health === undefined && !computer.error,
      short: health ? (health.ok ? `pi ${health.version}` : 'pi unavailable') : 'Not checked',
      detail: health
        ? health.ok
          ? `Ready · ${health.version}`
          : (health.reason ?? 'Install pi to run lanes.')
        : 'Could not check pi.',
      command: health && !health.ok ? PI_INSTALL : undefined,
    },
    {
      name: 'Claude',
      ok: claude?.binary.found === true && claude.auth.loggedIn === true,
      loading: claude === undefined && !computer.error,
      short: !claude
        ? 'Not checked'
        : !claude.binary.found
          ? 'Claude missing'
          : claude.auth.loggedIn
            ? 'Signed in'
            : 'Claude signed out',
      detail: claude
        ? !claude.binary.found
          ? 'Install the Claude CLI under Settings → Extensions → Claude Code.'
          : claude.auth.loggedIn
            ? 'Signed in'
            : 'Sign in under Settings → Accounts.'
        : 'Could not check Claude.',
    },
  ]
}

export function openProviderSettings(): void {
  useSettingsUiStore.getState().setTab('accounts')
  useSettingsUiStore.getState().setOpen(true)
}

export function LocalMachineDetail({ computer }: { computer: Computer }): React.JSX.Element {
  const liveHere = useSessionsStore((s) => Object.keys(s.live).length)
  const checks = localChecks(computer)
  const label = localMachineLabel(window.phosphor.platform)
  return (
    <div data-testid="machine-detail" className="space-y-4">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold">{label}</h1>
        <StatusPill tone="ok">Online</StatusPill>
        <p className="text-text-secondary basis-full text-base">
          {platformName(window.phosphor.platform)} · Your local lanes run here
          {liveHere ? ` · ${liveHere} live ${liveHere === 1 ? 'lane' : 'lanes'}` : ''}
        </p>
      </header>
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card title="Readiness">
            {computer.error && (
              <p role="alert" className="text-danger mb-2 text-base">
                Could not read all local checks. Open Settings to retry.
              </p>
            )}
            {checks.map((check) => (
              <CheckRow key={check.name} check={check} />
            ))}
          </Card>
          <Card title="Details">
            <Facts>
              <Fact label="Platform">{platformName(window.phosphor.platform)}</Fact>
              <Fact label="pi">
                {computer.health === undefined
                  ? 'Checking…'
                  : (computer.health?.version ?? 'Not available')}
              </Fact>
              <Fact label="Live lanes">{liveHere}</Fact>
            </Facts>
          </Card>
        </div>
        <Card
          title="Providers"
          aside={
            <Button size="xs" onClick={openProviderSettings}>
              Provider sign-ins
            </Button>
          }
        >
          {computer.providers === undefined ? (
            <div role="status" aria-label="Loading providers" className="space-y-3 py-1">
              {[0, 1].map((row) => (
                <div key={row} className="flex items-center gap-3">
                  <Skeleton className="h-3.5 w-36" />
                  <Skeleton className="ml-auto h-4 w-20 rounded-full" />
                </div>
              ))}
            </div>
          ) : !computer.providers?.length ? (
            <p className="text-text-secondary text-base">No subscription providers found.</p>
          ) : (
            <ul className="divide-border divide-y">
              {computer.providers.map((provider) => (
                <li key={provider.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-lg">{provider.name}</span>
                  {/* Most people use one or two providers: the rest are not problems. */}
                  <StatusPill tone={provider.status === 'ready' ? 'ok' : 'off'}>
                    {provider.status === 'ready' ? 'Signed in' : 'Not signed in'}
                  </StatusPill>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  )
}

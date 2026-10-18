import { useState } from 'react'
import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { openRemoteLane } from '@/stores/remoteLanes'
import type { ProviderLoginOp } from '@shared/host-protocol-providers'
import type { MachineTaskOp } from '@shared/machine-settings'
import { Card, StatusPill } from './MachineUi'
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
  const ids = state.accounts.map((account) => account.id)
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-semibold">Providers</h2>
        <p className="text-text-secondary mt-1 text-base">
          Accounts that run models on {label}. Credentials stay on that machine.
        </p>
      </div>
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
      <Card
        title="Claude accounts"
        aside={
          <Button
            size="xs"
            disabled={
              busy ||
              !programs.available ||
              state.claude.cli !== 'ok' ||
              state.accounts.length >= 16
            }
            onClick={() => programs.login('claude', { addAccount: true })}
          >
            Add account
          </Button>
        }
      >
        <div className="mb-4 space-y-2">
          <label className="text-text-secondary flex flex-wrap items-center justify-between gap-3 text-base">
            <span>Account for new Claude lanes</span>
            <select
              aria-label="Claude account routing"
              className="border-border bg-bg rounded-md border px-2 py-1"
              disabled={busy || !ids.length}
              value={state.mode}
              onChange={(e) =>
                void settings.change({
                  type: 'claude.routing',
                  mode: e.target.value as typeof state.mode,
                  ...(state.pinnedId
                    ? { pinnedId: state.pinnedId }
                    : ids[0]
                      ? { pinnedId: ids[0] }
                      : {}),
                })
              }
            >
              <option value="specific">Specific account</option>
              <option value="ordered">First available, in order</option>
              <option value="round-robin">Round-robin</option>
            </select>
          </label>
          {state.mode === 'specific' && ids.length > 0 && (
            <label className="text-text-secondary flex flex-wrap items-center justify-between gap-3 text-base">
              <span>Pinned account</span>
              <select
                aria-label="Pinned Claude account"
                value={state.pinnedId ?? ids[0]}
                disabled={busy}
                className="border-border bg-bg rounded-md border px-2 py-1"
                onChange={(e) =>
                  void settings.change({
                    type: 'claude.routing',
                    mode: 'specific',
                    pinnedId: e.target.value,
                  })
                }
              >
                {state.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <p className="text-text-tertiary text-sm">
            Chosen once when a lane starts. Ordered and round-robin routing skip accounts on
            cooldown. Resuming a lane keeps its original account; nothing switches mid-turn.
          </p>
        </div>
        {state.authenticating && (
          <p role="status" className="text-info mb-3 text-base">
            Sign-in or verification is still running on {label}…
          </p>
        )}
        {!ids.length && (
          <p className="text-text-secondary text-base">
            No verified Claude accounts yet. Add an account to sign in on {label}.
          </p>
        )}
        <ul className="divide-border divide-y">
          {state.accounts.map((account, index) => (
            <li key={account.id} data-account-id={account.id} className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <div className="min-w-0 flex-1">
                  <h4 className="truncate text-lg font-medium">{account.label}</h4>
                  <p className="text-text-secondary text-sm">
                    {[
                      account.email !== account.label ? account.email : null,
                      account.plan,
                      account.organization,
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Claude account on this Host'}
                  </p>
                </div>
                <StatusPill tone={account.loggedIn ? 'ok' : 'off'}>
                  {account.loggedIn
                    ? 'Signed in'
                    : account.loggedIn === null
                      ? 'Could not verify'
                      : 'Signed out'}
                </StatusPill>
              </div>
              {account.cooldownUntil && (
                <p className="text-warning text-sm">
                  Held for new lanes until {new Date(account.cooldownUntil).toLocaleString()}.
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="xs"
                  disabled={busy || !programs.available}
                  onClick={() => programs.login('claude', { accountId: account.id })}
                >
                  Sign in again
                </Button>
                <Button
                  size="xs"
                  disabled={busy || index === 0}
                  onClick={() => {
                    const next = [...ids]
                    ;[next[index - 1], next[index]] = [next[index]!, next[index - 1]!]
                    void settings.change({ type: 'claude.reorder', ids: next })
                  }}
                >
                  Move up
                </Button>
                <Button
                  size="xs"
                  disabled={busy || index === ids.length - 1}
                  onClick={() => {
                    const next = [...ids]
                    ;[next[index], next[index + 1]] = [next[index + 1]!, next[index]!]
                    void settings.change({ type: 'claude.reorder', ids: next })
                  }}
                >
                  Move down
                </Button>
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => {
                    setExpanded(expanded === account.id ? null : account.id)
                  }}
                >
                  Usage & lanes
                </Button>
                <Button
                  size="xs"
                  disabled={busy || account.lanes.some((lane) => lane.active)}
                  tooltip={
                    account.lanes.some((lane) => lane.active)
                      ? 'Stop or move this account’s active lanes first'
                      : `Sign out only on ${label}`
                  }
                  onClick={() =>
                    void (async () => {
                      if (
                        (await promptChoice({
                          title: `Sign out ${account.label} on ${label}?`,
                          message:
                            'Only this Host is affected. Stored lane bindings to the removed account are cleared; future resumes would use the routing policy.',
                          choices: [
                            { value: 'remove', label: 'Sign out and remove', primary: true },
                          ],
                        })) === 'remove'
                      )
                        await settings.change({ type: 'claude.remove', accountId: account.id })
                    })()
                  }
                >
                  Remove account
                </Button>
              </div>
              {expanded === account.id && (
                <div className="border-border space-y-3 rounded-md border p-3">
                  <Button
                    size="xs"
                    disabled={busy}
                    onClick={() =>
                      void settings.change({ type: 'claude.usage', accountId: account.id })
                    }
                  >
                    {settings.saving ? 'Checking usage…' : 'Refresh account usage'}
                  </Button>
                  {account.usage ? (
                    <div className="space-y-1">
                      {account.usage.stale && (
                        <p className="text-warning text-sm">
                          Last-known usage. The provider could not refresh it.
                        </p>
                      )}
                      {account.usage.windows.map((window) => (
                        <p key={window.label} className="text-text-secondary text-base">
                          {window.label}: {Math.round(window.percentUsed)}% used
                          {window.resetsAt
                            ? ` · resets ${new Date(window.resetsAt).toLocaleString()}`
                            : ''}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-text-secondary text-base">
                      No usage reading yet. Unavailable is not zero.
                    </p>
                  )}
                  <h5 className="text-text-tertiary font-mono text-xs uppercase">
                    Lanes on this account
                  </h5>
                  {!account.lanes.length ? (
                    <p className="text-text-secondary text-base">
                      No saved or running lanes are bound to this account.
                    </p>
                  ) : (
                    account.lanes.map((lane) => (
                      <div key={lane.id} className="flex flex-wrap items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-base">{lane.title}</span>
                        <span className="text-text-tertiary text-sm">
                          {lane.active ? 'Running' : 'Stopped'}
                        </span>
                        <Button size="xs" onClick={() => void openRemoteLane(hostId, lane.id)}>
                          Open lane
                        </Button>
                        <div className="flex w-full flex-wrap gap-2">
                          {state.accounts
                            .filter((target) => target.loggedIn === true)
                            .map((target) => (
                              <Button
                                key={target.id}
                                size="xs"
                                disabled={
                                  busy ||
                                  !settings.connection?.capabilities.includes('sessions.control')
                                }
                                onClick={() =>
                                  void (async () => {
                                    if (
                                      (await promptChoice({
                                        title: `${target.id === account.id ? 'Restart' : 'Move'} ${lane.title} on ${label}?`,
                                        message: `This explicitly stops and resumes the saved lane on ${target.label}${target.cooldownUntil ? ' (also held by quota)' : ''}. In-flight work may be interrupted. The next turn re-reads the thread and can cost tokens. No prompt is sent automatically, and another client’s control is never taken.`,
                                        choices: [
                                          {
                                            value: 'move',
                                            label:
                                              target.id === account.id
                                                ? 'Restart this lane'
                                                : `Move to ${target.label} and restart`,
                                            primary: true,
                                          },
                                        ],
                                      })) === 'move'
                                    )
                                      await settings.moveAccount(lane.id, target.id)
                                  })()
                                }
                              >
                                {target.id === account.id ? 'Restart' : `Move to ${target.label}`}
                              </Button>
                            ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
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
    </div>
  )
}

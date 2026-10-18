import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { openRemoteLane } from '@/stores/remoteLanes'
import type { MachineAccount } from '@shared/machine-settings'
import type { ProviderSectionProps } from './MachineProviderSections'
type AccountProps = ProviderSectionProps & { account: MachineAccount }
export function ClaudeAccountDetails(props: AccountProps): React.JSX.Element {
  const { account, busy, settings } = props
  return (
    <div className="border-border space-y-3 rounded-md border p-3">
      <Button
        size="xs"
        disabled={busy}
        onClick={() => void settings.change({ type: 'claude.usage', accountId: account.id })}
      >
        {settings.saving ? 'Checking usage…' : 'Refresh account usage'}
      </Button>
      <ClaudeAccountUsage account={account} />
      <h5 className="text-text-tertiary font-mono text-xs uppercase">Lanes on this account</h5>
      {!account.lanes.length ? (
        <p className="text-text-secondary text-base">
          No saved or running lanes are bound to this account.
        </p>
      ) : (
        account.lanes.map((lane) => (
          <ClaudeAccountLane key={lane.id} {...props} {...{ account, lane }} />
        ))
      )}
    </div>
  )
}

function ClaudeAccountUsage({ account }: { account: MachineAccount }): React.JSX.Element {
  return (
    <>
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
              {window.resetsAt ? ` · resets ${new Date(window.resetsAt).toLocaleString()}` : ''}
            </p>
          ))}
        </div>
      ) : (
        <p className="text-text-secondary text-base">
          No usage reading yet. Unavailable is not zero.
        </p>
      )}
    </>
  )
}
function ClaudeAccountLane(
  props: AccountProps & { lane: MachineAccount['lanes'][number] },
): React.JSX.Element {
  const { account, lane, state, busy, settings, hostId, label } = props
  return (
    <div key={lane.id} className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-base">{lane.title}</span>
      <span className="text-text-tertiary text-sm">{lane.active ? 'Running' : 'Stopped'}</span>
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
              disabled={busy || !settings.connection?.capabilities.includes('sessions.control')}
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
  )
}

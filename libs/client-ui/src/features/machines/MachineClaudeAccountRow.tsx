import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import type { MachineAccount } from '@shared/machine-settings'
import type { Dispatch, SetStateAction } from 'react'
import { ClaudeAccountDetails } from './MachineClaudeAccountDetails'
import type { ProviderSectionProps } from './MachineProviderSections'
import { StatusPill } from './MachineUi'
export interface AccountRowProps extends ProviderSectionProps {
  account: MachineAccount
  index: number
  ids: string[]
  expanded: string | null
  setExpanded: Dispatch<SetStateAction<string | null>>
}
export function ClaudeAccountRow(props: AccountRowProps): React.JSX.Element {
  const { account, expanded } = props
  return (
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
      <ClaudeAccountActions {...props} />
      {expanded === account.id && <ClaudeAccountDetails {...props} account={account} />}
    </li>
  )
}
function ClaudeAccountActions(props: AccountRowProps): React.JSX.Element {
  const { account, index, ids, expanded, setExpanded, busy, programs, settings } = props
  return (
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
      <RemoveClaudeAccount {...props} account={account} />
    </div>
  )
}

function RemoveClaudeAccount({
  account,
  busy,
  label,
  settings,
}: ProviderSectionProps & { account: MachineAccount }): React.JSX.Element {
  return (
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
              choices: [{ value: 'remove', label: 'Sign out and remove', primary: true }],
            })) === 'remove'
          )
            await settings.change({ type: 'claude.remove', accountId: account.id })
        })()
      }
    >
      Remove account
    </Button>
  )
}

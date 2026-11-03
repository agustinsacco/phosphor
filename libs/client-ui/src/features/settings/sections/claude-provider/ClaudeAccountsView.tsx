import { useState } from 'react'
import type { ClaudeRoutingMode } from '@shared/models'
import { TooltipButton, TooltipLabel } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { Spinner } from '@/components/icons'
import { useAsyncAction } from '@/components/useAsyncAction'
import { promptChoice } from '@/stores/prompt'
import {
  primaryAccountId,
  type ClaudeAccountModel,
  type ClaudeAccountsSource,
} from '../accounts/accountsModel'
import { ClaudeAccountDetails } from './ClaudeAccountDetails'
import { ClaudeAccountActions, ClaudeAccountRow } from './ClaudeAccountRow'
import { SignInProgress } from '../../components/SignInProgress'

const ROUTING_OPTIONS: { value: ClaudeRoutingMode; title: string; detail: string }[] = [
  {
    value: 'specific',
    title: 'One account',
    detail: 'Every session bills the account you pick below.',
  },
  {
    value: 'ordered',
    title: 'In order, top to bottom',
    detail:
      'A new session starts on the highest account that still has 5-hour quota. Reorder with the arrows.',
  },
  {
    value: 'round-robin',
    title: 'Round robin',
    detail: 'Each new session takes the next account in the list, spreading load across plans.',
  },
]

async function confirmRemove(account: ClaudeAccountModel): Promise<boolean> {
  const choice = await promptChoice({
    title: `Remove ${account.label}?`,
    message:
      'This signs the account out on this machine and forgets it. Saved lanes bound to it follow the routing rule when they resume.',
    choices: [{ value: 'remove', label: 'Sign out and remove', primary: true }],
  })
  return choice === 'remove'
}

/**
 * Claude logins, in routing order, and the rule that picks between them. The
 * account is fixed when a session STARTS; "out of quota" is a cached reading.
 */
export function ClaudeAccountsView({
  source,
}: {
  source: ClaudeAccountsSource
}): React.JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const action = useAsyncAction()
  const { accounts, mode, busy } = source
  const specific = mode === 'specific'
  const pinned = primaryAccountId(accounts, source.pinnedId)
  const move = (index: number, delta: number): void => {
    const ids = accounts.map((a) => a.id)
    const target = index + delta
    if (target < 0 || target >= ids.length) return
    const [moved] = ids.splice(index, 1)
    ids.splice(target, 0, moved!)
    source.reorder(ids)
  }
  const remove = (account: ClaudeAccountModel): void =>
    void action.run(async () => {
      if (await confirmRemove(account)) await source.remove(account.id)
    })
  return (
    <>
      <AccountsIntro terminal={source.caps.signIn === 'terminal'} />
      <div className="border-border divide-border mt-2 divide-y rounded-lg border">
        {source.status === 'loading' ? (
          <div className="text-text-secondary flex items-center gap-2 px-3.5 py-2.5 text-base">
            <Spinner /> Reading the Claude logins…
          </div>
        ) : accounts.length === 0 ? (
          <div className="text-text-secondary px-3.5 py-2.5 text-base">
            No Claude account yet. Add one below.
          </div>
        ) : (
          accounts.map((account, index) => (
            <ClaudeAccountRow
              key={account.id}
              account={account}
              live={source.caps.lanes === 'live'}
              pin={
                specific
                  ? {
                      checked: pinned === account.id,
                      disabled: busy,
                      onPin: () => source.route('specific', account.id),
                    }
                  : undefined
              }
              expanded={expanded === account.id}
              onToggle={() => setExpanded((open) => (open === account.id ? null : account.id))}
              actions={
                <ClaudeAccountActions
                  account={account}
                  index={index}
                  count={accounts.length}
                  busy={busy || action.busy}
                  onMove={move}
                  onReauth={() => source.reauth(account.id)}
                  onRemove={() => remove(account)}
                />
              }
            >
              <ClaudeAccountDetails account={account} source={source} />
            </ClaudeAccountRow>
          ))
        )}
      </div>
      {action.error && <p className="text-danger mt-2 text-base">{action.error}</p>}
      <AccountsToolbar source={source} />
      {accounts.length > 0 && (
        <RoutingOptions
          mode={mode}
          disabled={busy}
          onRoute={(next) => source.route(next, pinned)}
        />
      )}
    </>
  )
}

function AccountsIntro({ terminal }: { terminal: boolean }): React.JSX.Element {
  return (
    <>
      <h3 className="mt-6 text-lg font-semibold">Accounts</h3>
      <p className="text-text-secondary mt-1 text-base">
        Each account keeps its own credential, so they sit side by side rather than replacing one
        another. The account is chosen when a session <strong>starts</strong> and stays fixed for
        its whole life — a resumed session always bills the account it began on.
      </p>
      <p className="text-text-secondary mt-1 text-base">
        Open a row for that account&apos;s own plan usage and the lanes spending it. A lane on a
        spent account can be restarted there, or moved to another account — both respawn it, so the
        next turn re-reads the whole thread and pays for it once.
      </p>
      <p className="text-text-tertiary mt-1 text-sm">
        {terminal
          ? 'Adding an account opens a private terminal on this machine. Open the link it prints on any computer, sign in, then paste the code back into the terminal.'
          : 'Adding an account opens Claude’s sign-in page. If your browser signs you straight back into the account you already have, sign out at claude.ai first.'}{' '}
        Signing in as an email that is already listed re-authenticates that row instead of adding a
        second one.
      </p>
    </>
  )
}

/** Add an account (or cancel the sign-in under way), refresh usage, and the paste-code step. */
function AccountsToolbar({ source }: { source: ClaudeAccountsSource }): React.JSX.Element {
  const { login, busy } = source
  return (
    <>
      <div className="mt-2.5 flex items-center gap-3">
        {login !== null && source.cancelLogin ? (
          <TooltipButton
            onClick={source.cancelLogin}
            className="text-text-secondary hover:text-text text-base"
          >
            Cancel sign-in
          </TooltipButton>
        ) : (
          <Button
            variant="secondary"
            disabled={busy || source.addBlocked !== null}
            tooltip={source.addBlocked ?? undefined}
            onClick={source.add}
          >
            Add account
          </Button>
        )}
        <TooltipButton
          onClick={source.refreshUsage}
          disabled={busy || source.accounts.length === 0}
          className="text-text-secondary hover:text-text text-base disabled:opacity-50"
        >
          Refresh usage
        </TooltipButton>
      </div>
      <SignInProgress flow={login} who="the Claude CLI" onSubmit={source.submitCode} />
    </>
  )
}

function RoutingOptions({
  mode,
  disabled,
  onRoute,
}: {
  mode: ClaudeRoutingMode
  disabled: boolean
  onRoute: (mode: ClaudeRoutingMode) => void
}): React.JSX.Element {
  return (
    <>
      <h4 className="mt-5 text-base font-semibold">Route new sessions</h4>
      <div className="border-border divide-border mt-2 divide-y rounded-lg border">
        {ROUTING_OPTIONS.map((option) => (
          <TooltipLabel
            key={option.value}
            className="hover:bg-surface-raised flex cursor-pointer items-start gap-3 px-3.5 py-2.5"
          >
            <input
              type="radio"
              name="claude-routing"
              className="accent-accent mt-1"
              checked={mode === option.value}
              disabled={disabled}
              onChange={() => onRoute(option.value)}
            />
            <div className="min-w-0">
              <div className="text-base font-medium">{option.title}</div>
              <div className="text-text-tertiary text-sm">{option.detail}</div>
            </div>
          </TooltipLabel>
        ))}
      </div>
      {mode !== 'specific' && (
        <p className="text-text-tertiary mt-2 text-sm">
          “Out of quota” is read from each account&apos;s cached{' '}
          <span className="font-mono">/usage</span>, refreshed in the background after a session
          starts. Press <strong>Refresh usage</strong> to make the next choice use live numbers.
        </p>
      )}
    </>
  )
}

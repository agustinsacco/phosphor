import { TooltipButton } from '@/components/Tooltip'
import type { LoginFlowState } from '@shared/models'
import { Button } from '@/components/form'
import { SignInProgress } from '../../components/SignInProgress'
import clsx from 'clsx'
import {
  SIGN_IN_LABEL,
  type ProviderAccountsSource,
  type ProviderRow as Row,
} from './accountsModel'

const GROUPS = [
  { billing: 'subscription', title: 'Use a plan you already pay for' },
  {
    billing: 'balance',
    title: 'Billed per token',
    caption: 'These sign in the same way, but usage is charged against a credit balance.',
  },
  {
    billing: undefined,
    title: 'Other providers',
    caption: 'Providers pi is configured for on this machine, such as one with an API key.',
  },
] as const

type ListSource = Pick<ProviderAccountsSource, 'providers' | 'flow' | 'busy' | 'signIn' | 'cancel'>

/**
 * pi's providers, grouped by what signing in spends, each with its sign-in
 * state, what it needs and, where the machine has one, its sign-in action.
 */
export function ProviderList({ source }: { source: ListSource }): React.JSX.Element {
  return (
    <>
      {GROUPS.map((group) => {
        const rows = source.providers.filter((p) => p.billing === group.billing)
        if (rows.length === 0) return null
        return (
          <section key={group.title} className="mt-5">
            <h3 className="text-text-secondary text-sm font-medium uppercase tracking-wide">
              {group.title}
            </h3>
            {'caption' in group && (
              <p className="text-text-tertiary mt-1 text-sm">{group.caption}</p>
            )}
            <div className="border-border divide-border mt-2 divide-y rounded-lg border">
              {rows.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  source={source}
                  flow={source.flow?.providerId === provider.id ? source.flow : null}
                />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

function ProviderRow({
  provider,
  source,
  flow,
}: {
  provider: Row
  source: ListSource
  flow: LoginFlowState | null
}): React.JSX.Element {
  const ready = provider.status === 'ready'
  return (
    <div className="px-3.5 py-3" data-provider={provider.id}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium">{provider.name}</span>
            <SignInPill state={provider.status} reason={provider.reason ?? provider.error} />
          </div>
          {ready && provider.account && (
            // Which account, not just whether: with two ChatGPT logins on one
            // machine, "Signed in" alone does not say which one pi will bill.
            <p
              className="text-text-secondary mt-0.5 truncate text-sm"
              data-tooltip={provider.account}
            >
              {provider.account}
            </p>
          )}
          {provider.requires && (
            <p className="text-text-secondary mt-0.5 text-sm">Requires {provider.requires}.</p>
          )}
          {provider.caveat && <p className="text-text-tertiary mt-1 text-sm">{provider.caveat}</p>}
          {provider.error && <p className="text-danger mt-1 text-sm">{provider.error}</p>}
        </div>
        {source.signIn && (
          <div className="shrink-0">
            {flow && source.cancel ? (
              <TooltipButton
                onClick={() => source.cancel?.(provider.id)}
                className="text-text-secondary hover:text-text text-base"
              >
                Cancel
              </TooltipButton>
            ) : (
              <Button
                variant="secondary"
                // One sign-in at a time: pi writes a single auth.json.
                disabled={source.busy}
                onClick={() => source.signIn?.(provider.id)}
              >
                {ready ? 'Sign in again' : 'Sign in'}
              </Button>
            )}
          </div>
        )}
      </div>
      <SignInProgress flow={flow} who="pi" />
    </div>
  )
}

const PILL = {
  ready: 'bg-success/15 text-success',
  not_ready: 'bg-warning/15 text-warning',
  unknown: 'bg-bg-secondary text-text-secondary',
} as const

/**
 * Signed in, not signed in, or could not verify: one word set for pi providers
 * and Claude accounts on every machine. "Could not verify" is never read as
 * signed out.
 */
export function SignInPill({
  state,
  reason,
}: {
  state: keyof typeof SIGN_IN_LABEL
  /** Why it could not be verified. */
  reason?: string
}): React.JSX.Element {
  return (
    <span
      data-sign-in={state}
      data-tooltip={reason}
      className={clsx('shrink-0 rounded-full px-2 py-0.5 text-sm font-normal', PILL[state])}
    >
      {SIGN_IN_LABEL[state]}
    </span>
  )
}

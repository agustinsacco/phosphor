import { TooltipButton } from '@/components/Tooltip'
import type { LoginFlowState } from '@shared/models'
import { Button } from '@/components/form'
import { Spinner } from '@/components/icons'
import type { ProviderAccountsSource, ProviderRow as Row } from './accountsModel'
import { SignInPill } from './SignInPill'

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
            <div className="border-border mt-2 divide-y rounded-lg border">
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
      {flow && <ProviderLoginProgress flow={flow} />}
    </div>
  )
}

/** The middle of an in-app sign-in: what pi is doing, and what the user must do. */
function ProviderLoginProgress({ flow }: { flow: LoginFlowState }): React.JSX.Element | null {
  if (flow.phase === 'starting')
    return (
      <div className="text-text-secondary mt-3 flex items-center gap-2 text-sm">
        <Spinner />
        Starting pi’s sign-in…
      </div>
    )
  if (flow.phase !== 'awaiting-browser') return null
  return (
    <div className="border-border bg-surface-raised mt-3 rounded-md border p-3">
      <div className="text-text-secondary flex items-center gap-2 text-sm">
        <Spinner />
        Waiting for you to finish in your browser.
      </div>
      {flow.userCode && (
        <div className="mt-2.5">
          {/* The device code is the step people miss: the browser page asks for
              it, and it is nowhere else on screen. */}
          <p className="text-text-tertiary text-sm">Enter this code on the page:</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="border-border bg-surface rounded border px-2 py-1 font-mono text-base tracking-widest">
              {flow.userCode}
            </code>
            <TooltipButton
              onClick={() => void navigator.clipboard.writeText(flow.userCode ?? '')}
              className="text-text-secondary hover:text-text text-sm"
            >
              Copy
            </TooltipButton>
          </div>
        </div>
      )}
      <TooltipButton
        onClick={() => void window.phosphor.invoke('app:openExternal', flow.url)}
        className="text-accent mt-2.5 block text-sm hover:underline"
      >
        Browser didn’t open? Open the sign-in page again
      </TooltipButton>
    </div>
  )
}

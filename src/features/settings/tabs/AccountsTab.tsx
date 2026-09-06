import { useCallback, useEffect, useState } from 'react'
import type { LoginFlowState, LoginProviderId, SubscriptionProviderStatus } from '@shared/models'
import { Button } from '@/components/form'
import { CheckIcon, Spinner } from '@/components/icons'
import { TerminalView } from '@/features/terminal/TerminalView'

/**
 * Signing pi into a provider.
 *
 * The sign-in itself is pi's TUI, driven off-screen by the main process (see
 * `electron/pi/login-flow.ts`). What the user sees here is a button per
 * provider, their browser opening, and the row flipping to "Signed in" — the
 * terminal below is the escape hatch for a provider whose prompts that driver
 * does not know how to answer, not the normal path.
 */
export function AccountsTab(): React.JSX.Element {
  const [providers, setProviders] = useState<SubscriptionProviderStatus[] | null>(null)
  const [flow, setFlow] = useState<LoginFlowState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ptyId, setPtyId] = useState<string | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setProviders(await window.pidex.invoke('pi:subscriptionAuth'))
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(
    () =>
      window.pidex.onPiLoginState((state) => {
        setFlow(state.phase === 'signed-in' || state.phase === 'cancelled' ? null : state)
        if (state.phase === 'error') setError(state.message)
        // Re-check on every terminal phase, not just success: a cancelled or
        // failed attempt can still have written credentials before it stopped.
        if (state.phase === 'signed-in' || state.phase === 'cancelled') void refresh()
      }),
    [refresh],
  )

  const signIn = async (providerId: LoginProviderId): Promise<void> => {
    setError(null)
    setFlow({ providerId, phase: 'starting' })
    try {
      await window.pidex.invoke('pi:startLogin', providerId)
    } catch (caught) {
      setFlow(null)
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const cancel = (providerId: LoginProviderId): void => {
    void window.pidex.invoke('pi:cancelLogin', providerId)
    setFlow(null)
  }

  const openTerminal = async (): Promise<void> => {
    setError(null)
    try {
      const { ptyId: id } = await window.pidex.invoke('pi:loginTerminal', 80, 20)
      setPtyId(id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const closeTerminal = (): void => {
    if (ptyId) void window.pidex.invoke('pty:kill', ptyId)
    setPtyId(null)
    void refresh()
  }

  const subscriptions = providers?.filter((p) => p.billing === 'subscription') ?? []
  const balances = providers?.filter((p) => p.billing === 'balance') ?? []

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Accounts</h2>
      <p className="text-text-secondary mt-1 text-base">
        Sign pi into a provider instead of pasting an API key. Signed-in providers put their models
        in the picker for every session.
      </p>

      {providers === null ? (
        <div className="text-text-secondary mt-4 text-base">Checking…</div>
      ) : (
        <>
          <ProviderGroup
            title="Use a plan you already pay for"
            providers={subscriptions}
            flow={flow}
            onSignIn={signIn}
            onCancel={cancel}
          />
          {balances.length > 0 && (
            <ProviderGroup
              title="Billed per token"
              caption="These sign in the same way, but usage is charged against a credit balance."
              providers={balances}
              flow={flow}
              onSignIn={signIn}
              onCancel={cancel}
            />
          )}
        </>
      )}

      {error && <p className="text-danger mt-3 text-base">{error}</p>}

      <div className="mt-5 flex items-center gap-4">
        <button
          onClick={() => void refresh()}
          className="text-text-secondary hover:text-text text-base"
        >
          Refresh
        </button>
        {ptyId === null && (
          <button
            onClick={() => void openTerminal()}
            className="text-text-tertiary hover:text-text text-base"
          >
            Open pi’s login terminal
          </button>
        )}
      </div>

      {ptyId !== null && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-text-secondary text-base">
              pi’s own <span className="font-mono">/login</span>. Type it and press Enter.
            </p>
            <button
              onClick={closeTerminal}
              className="text-text-secondary hover:text-text text-base"
            >
              Done
            </button>
          </div>
          <div className="border-border h-64 overflow-hidden rounded-lg border p-2">
            <TerminalView ptyId={ptyId} visible />
          </div>
        </div>
      )}
    </div>
  )
}

function ProviderGroup({
  title,
  caption,
  providers,
  flow,
  onSignIn,
  onCancel,
}: {
  title: string
  caption?: string
  providers: SubscriptionProviderStatus[]
  flow: LoginFlowState | null
  onSignIn: (id: LoginProviderId) => Promise<void>
  onCancel: (id: LoginProviderId) => void
}): React.JSX.Element {
  return (
    <section className="mt-5">
      <h3 className="text-text-secondary text-sm font-medium tracking-wide uppercase">{title}</h3>
      {caption && <p className="text-text-tertiary mt-1 text-sm">{caption}</p>}
      <div className="border-border mt-2 divide-y rounded-lg border">
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            flow={flow?.providerId === provider.id ? flow : null}
            // One sign-in at a time: pi writes a single auth.json, and two
            // device flows racing it is a support ticket waiting to happen.
            disabled={flow !== null && flow.providerId !== provider.id}
            onSignIn={onSignIn}
            onCancel={onCancel}
          />
        ))}
      </div>
    </section>
  )
}

function ProviderRow({
  provider,
  flow,
  disabled,
  onSignIn,
  onCancel,
}: {
  provider: SubscriptionProviderStatus
  flow: LoginFlowState | null
  disabled: boolean
  onSignIn: (id: LoginProviderId) => Promise<void>
  onCancel: (id: LoginProviderId) => void
}): React.JSX.Element {
  const ready = provider.status === 'ready'
  const busy = flow !== null

  return (
    <div className="px-3.5 py-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-base font-medium">{provider.name}</span>
            {ready && (
              <span className="bg-success/15 text-success inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-sm">
                <CheckIcon size={11} />
                Signed in
              </span>
            )}
            {provider.status === 'unknown' && (
              <span
                className="bg-warning/15 text-warning rounded-full px-2 py-0.5 text-sm"
                title={provider.reason ?? provider.error}
              >
                Unknown
              </span>
            )}
          </div>
          {ready && provider.account && (
            // Which account, not just whether: with two ChatGPT logins on one
            // machine, "Signed in" alone does not say which one pi will bill.
            <p className="text-text-secondary mt-0.5 truncate text-sm" title={provider.account}>
              {provider.account}
            </p>
          )}
          <p className="text-text-secondary mt-0.5 text-sm">Requires {provider.requires}.</p>
          {provider.caveat && <p className="text-text-tertiary mt-1 text-sm">{provider.caveat}</p>}
          {provider.error && <p className="text-danger mt-1 text-sm">{provider.error}</p>}
        </div>

        <div className="shrink-0">
          {busy ? (
            <button
              onClick={() => onCancel(provider.id)}
              className="text-text-secondary hover:text-text text-base"
            >
              Cancel
            </button>
          ) : (
            <Button
              variant="secondary"
              disabled={disabled}
              onClick={() => void onSignIn(provider.id)}
            >
              {ready ? 'Sign in again' : 'Sign in'}
            </Button>
          )}
        </div>
      </div>

      {flow && <LoginProgress flow={flow} />}
    </div>
  )
}

/** The middle of a sign-in: what pi is doing, and what the user must do. */
function LoginProgress({ flow }: { flow: LoginFlowState }): React.JSX.Element | null {
  if (flow.phase === 'starting') {
    return (
      <div className="text-text-secondary mt-3 flex items-center gap-2 text-sm">
        <Spinner />
        Starting pi’s sign-in…
      </div>
    )
  }

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
            <button
              onClick={() => void navigator.clipboard.writeText(flow.userCode ?? '')}
              className="text-text-secondary hover:text-text text-sm"
            >
              Copy
            </button>
          </div>
        </div>
      )}

      <button
        onClick={() => void window.pidex.invoke('app:openExternal', flow.url)}
        className="text-accent mt-2.5 block text-sm hover:underline"
      >
        Browser didn’t open? Open the sign-in page again
      </button>
    </div>
  )
}

import { CheckIcon, WarningIcon, ReloadIcon } from '@/components/icons'
import { useEffect, useRef, useState } from 'react'
import type { TailscaleCode, TailscaleStatus } from '@shared/tailscale-status'
import { useAccount } from '@/features/settings/useAccount'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { Button } from '@/components/form'

export const TAILSCALE_FIXES: Record<TailscaleCode, string> = {
  ready: 'Tailscale is running and logged in. MagicDNS and HTTPS certificates are available.',
  'not-installed': 'Install Tailscale on this computer, then sign in to your tailnet.',
  'not-running': 'Open Tailscale and connect to your tailnet, then check again.',
  'signed-out': 'Sign in to Tailscale and approve this computer in its admin console.',
  'magicdns-unavailable': 'Turn on MagicDNS in the Tailscale admin console DNS settings.',
  'https-unavailable': 'Turn on HTTPS certificates in the Tailscale admin console DNS settings.',
  'check-failed': 'Could not check Tailscale. Open Tailscale to check your connection manually.',
}
export function BeforeYouStart(): React.JSX.Element {
  const { view } = useAccount()
  const signedIn = view?.account.status === 'signed-in'
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)
  async function check(): Promise<void> {
    const id = ++request.current
    setBusy(true)
    try {
      const next = await window.phosphor.invoke('hosts:tailscaleStatus')
      if (id === request.current) setStatus(next)
    } catch {
      if (id === request.current) setStatus({ code: 'check-failed' })
    } finally {
      if (id === request.current) setBusy(false)
    }
  }
  useEffect(() => {
    void check()
    return () => {
      request.current++
    }
  }, [])
  return (
    <section className="space-y-4" aria-label="Before you start">
      <h2 className="text-xl font-semibold">Bring another machine online</h2>
      <p className="text-text-secondary">
        The new machine needs Tailscale signed in on your tailnet and pi. Run the command in its
        terminal; it does the rest.
      </p>
      <div className="border-border bg-bg-secondary space-y-3 rounded-lg border p-4">
        <h3 className="flex items-center gap-2 font-medium">
          <CheckStatus passed={signedIn} /> Phosphor account
        </h3>
        <p className="text-text-secondary pl-6">
          {signedIn
            ? 'Signed in to Phosphor.'
            : 'Sign in with GitHub in Settings → Accounts before approving a machine.'}
        </p>
        {!signedIn && (
          <Button
            className="ml-6"
            onClick={() => {
              useSettingsUiStore.getState().setTab('accounts')
              useSettingsUiStore.getState().setOpen(true)
            }}
          >
            Open Settings
          </Button>
        )}
        <h3 className="flex items-center gap-2 font-medium">
          <CheckStatus passed={status?.code === 'ready'} checking={busy} /> Tailscale on this
          computer
        </h3>
        <p role="status" className="text-text-secondary pl-6">
          {busy
            ? 'Checking Tailscale…'
            : status
              ? TAILSCALE_FIXES[status.code]
              : 'Checking Tailscale…'}
        </p>
        <div className="flex flex-wrap gap-2 pl-6">
          <Button disabled={busy} onClick={() => void check()}>
            Check again
          </Button>
          {status?.code === 'not-installed' && (
            <Button
              onClick={() =>
                void window.phosphor.invoke('app:openExternal', 'https://tailscale.com/download')
              }
            >
              Install Tailscale
            </Button>
          )}
          {(status?.code === 'magicdns-unavailable' || status?.code === 'https-unavailable') && (
            <Button
              onClick={() =>
                void window.phosphor.invoke(
                  'app:openExternal',
                  'https://tailscale.com/kb/1153/enabling-https',
                )
              }
            >
              Tailscale DNS and HTTPS help
            </Button>
          )}
        </div>
      </div>
      <p className="text-text-secondary text-sm">
        Checks are read-only. If the CLI is unavailable, verify Tailscale manually and continue with
        the terminal command.
      </p>
    </section>
  )
}

function CheckStatus({
  passed,
  checking = false,
}: {
  passed: boolean
  checking?: boolean
}): React.JSX.Element {
  return checking ? (
    <span aria-label="Checking">
      <ReloadIcon size={16} className="animate-spin text-text-secondary" />
    </span>
  ) : passed ? (
    <span aria-label="Passed">
      <CheckIcon size={16} className="text-success" />
    </span>
  ) : (
    <span aria-label="Needs attention">
      <WarningIcon size={16} className="text-warning" />
    </span>
  )
}

import { CheckIcon, WarningIcon, ReloadIcon, MachinesIcon, TerminalIcon } from '@/components/icons'
import { useEffect, useRef, useState } from 'react'
import type { TailscaleCode, TailscaleStatus } from '@shared/tailscale-status'
import { useAccount } from '@/features/settings/useAccount'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useMachinesStore } from '@/stores/machines'
import { Button, Row, Toggle } from '@/components/form'
import { discoveryCandidates } from './discoveryCandidates'

const fixes: Record<TailscaleCode, string> = {
  ready: 'Tailscale is running and logged in. MagicDNS and HTTPS certificates are available.',
  'not-installed': 'Install Tailscale on this computer, then sign in to your tailnet.',
  'not-running': 'Open Tailscale and connect to your tailnet, then check again.',
  'signed-out': 'Sign in to Tailscale and approve this computer in its admin console.',
  'magicdns-unavailable': 'Turn on MagicDNS in the Tailscale admin console DNS settings.',
  'https-unavailable': 'Turn on HTTPS certificates in the Tailscale admin console DNS settings.',
  'check-failed': 'Could not check Tailscale. Open Tailscale to check your connection manually.',
}
export function BeforeYouStart({
  onPick,
  installActive = false,
  onReturnToInstall,
}: {
  onPick: (target: string) => void
  installActive?: boolean
  onReturnToInstall?: () => void
}): React.JSX.Element {
  const { view } = useAccount()
  const signedIn = view?.account.status === 'signed-in'
  const machines = useMachinesStore((s) => s.machines)
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<'save' | 'status' | null>(null)
  const request = useRef(0)
  async function check(enabled?: boolean): Promise<void> {
    const id = ++request.current
    setBusy(true)
    setError(null)
    const previous = status
    if (enabled !== undefined) setStatus((s) => s && { ...s, discovery: enabled, peers: [] })
    let savedDiscovery = previous?.discovery ?? false
    try {
      if (enabled !== undefined) {
        try {
          await window.phosphor.invoke('hosts:setTailscaleDiscovery', enabled)
          savedDiscovery = enabled
        } catch {
          if (id === request.current) {
            setStatus(previous)
            setError('save')
          }
          return
        }
      }
      const next = await window.phosphor.invoke('hosts:tailscaleStatus')
      if (id === request.current) setStatus(next)
    } catch {
      if (id === request.current) {
        setStatus({ code: 'check-failed', discovery: savedDiscovery, peers: [] })
        setError('status')
      }
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
  const peers = discoveryCandidates(status?.peers ?? [], machines)
  return (
    <section className="space-y-4" aria-label="Before you start">
      <h2 className="text-xl font-semibold">Bring another machine online</h2>
      <p className="text-text-secondary">
        You will need SSH access or a terminal on the other machine, pi installed there, and both
        computers on your tailnet.
      </p>
      <div className="border-border bg-bg-secondary space-y-3 rounded-lg border p-4">
        <h3 className="flex items-center gap-2 font-medium">
          <CheckStatus passed={signedIn} /> Phosphor account
        </h3>
        <p className="text-text-secondary">
          {signedIn
            ? 'Signed in to Phosphor.'
            : 'Sign in with GitHub in Settings → Accounts before approving a machine.'}
        </p>
        {!signedIn && (
          <Button
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
        <p role="status" className="text-text-secondary">
          {busy ? 'Checking Tailscale…' : status ? fixes[status.code] : 'Checking Tailscale…'}
        </p>
        {error === 'save' && (
          <p role="alert">Could not save discovery. Your preference has not changed. Try again.</p>
        )}
        <div className="flex flex-wrap gap-2">
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
      <Row
        title="Suggest machines from my tailnet"
        description="Off by default. Suggestions only fill in the SSH address; nothing connects until you install."
      >
        <Toggle
          on={status?.discovery === true}
          disabled={busy || !status}
          onChange={(enabled) => void check(enabled)}
        />
      </Row>
      {status?.discovery && (
        <div className="space-y-2" aria-label="Tailscale suggestions">
          {installActive && (
            <div className="space-y-2">
              <p className="text-text-secondary">
                An SSH installation is already in progress. Continue to Install to return to it.
              </p>
              <Button onClick={onReturnToInstall}>Return to Install</Button>
            </div>
          )}
          {busy ? (
            <p role="status" className="text-text-secondary">
              Loading suggestions…
            </p>
          ) : peers.length ? (
            <ul className="divide-border divide-y rounded-lg border border-border">
              {peers.map((peer) => {
                const Icon = peer.os === 'linux' ? TerminalIcon : MachinesIcon
                return (
                  <li key={peer.dnsName} className="flex items-center gap-3 p-3">
                    <span aria-label={peer.os}>
                      <Icon size={18} className="text-text-secondary shrink-0" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{peer.dnsName.split('.')[0]}</p>
                      <p className="text-text-secondary break-all text-sm">{peer.dnsName}</p>
                    </div>
                    <Button
                      disabled={installActive}
                      aria-label={`Use ${peer.dnsName}`}
                      onClick={() => onPick(peer.dnsName)}
                    >
                      Use
                    </Button>
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-text-secondary">No other online machines found on your tailnet.</p>
          )}
        </div>
      )}
      <p className="text-text-secondary text-sm">
        Checks are read-only. If the CLI is unavailable, verify Tailscale manually and continue with
        SSH or the terminal commands.
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

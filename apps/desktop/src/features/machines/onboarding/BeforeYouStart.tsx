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
}: {
  onPick: (target: string) => void
}): React.JSX.Element {
  const { view } = useAccount()
  const signedIn = view?.account.status === 'signed-in'
  const machines = useMachinesStore((s) => s.machines)
  const [status, setStatus] = useState<TailscaleStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const request = useRef(0)
  async function check(enabled?: boolean): Promise<void> {
    const id = ++request.current
    setBusy(true)
    setError(false)
    const previous = status
    if (enabled !== undefined) setStatus((s) => s && { ...s, discovery: enabled, peers: [] })
    try {
      if (enabled !== undefined)
        await window.phosphor.invoke('hosts:setTailscaleDiscovery', enabled)
      const next = await window.phosphor.invoke('hosts:tailscaleStatus')
      if (id === request.current) setStatus(next)
    } catch {
      if (id === request.current) {
        setStatus(previous)
        setError(true)
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
        <h3 className="font-medium">Phosphor account</h3>
        <p>
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
        <h3 className="font-medium">Tailscale on this computer</h3>
        <p role="status">{status ? fixes[status.code] : 'Checking Tailscale…'}</p>
        {error && <p role="alert">Could not check or save discovery. Try again.</p>}
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void check()}>
            Check again
          </Button>
          <Button
            onClick={() =>
              void window.phosphor.invoke('app:openExternal', 'https://tailscale.com/download')
            }
          >
            Install Tailscale
          </Button>
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
        </div>
      </div>
      <Row
        title="Suggest online Tailscale peers"
        description="Optional. Off by default. Suggestions are not identity proof. Nothing connects until you explicitly install."
      >
        <Toggle
          on={status?.discovery === true}
          disabled={busy || !status}
          onChange={(enabled) => void check(enabled)}
        />
      </Row>
      {status?.discovery && (
        <div className="space-y-2" aria-label="Tailscale suggestions">
          {peers.length ? (
            peers.map((peer) => (
              <Button key={peer.dnsName} onClick={() => onPick(peer.dnsName)}>
                {peer.dnsName} · {peer.os}
              </Button>
            ))
          ) : (
            <p className="text-text-secondary">
              No unenrolled online peers found. You can enter an SSH target manually.
            </p>
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

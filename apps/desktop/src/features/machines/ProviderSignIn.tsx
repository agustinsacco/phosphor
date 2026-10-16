import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
const TerminalView = lazy(() =>
  import('@/features/terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
)
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { MachineProvider } from '@shared/host-protocol-machine'

/** Provider contents and credentials stay on the authenticated Host terminal connection. */
export function ProviderSignIn({
  hostId,
  refresh = 0,
}: {
  hostId: string
  refresh?: number
}): React.JSX.Element {
  const live = useRef(true)
  const currentHost = useRef(hostId)
  currentHost.current = hostId
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [providers, setProviders] = useState<MachineProvider[]>([])
  const [terminal, setTerminal] = useState<{ ptyId: string; provider: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const allowed =
    host?.state === 'ready' &&
    host.capabilities.includes('terminal') &&
    host.capabilities.includes('sessions.control')
  const readable = host?.state === 'ready' && host.capabilities.includes('skills.read')
  useEffect(() => {
    let live = true
    setLoadFailed(false)
    if (readable)
      void window.phosphor.invoke('hosts:providers', hostId).then(
        (rows) => {
          if (live) setProviders(rows)
        },
        () => {
          // A failed read is not "no providers": say so and offer a retry.
          if (live) {
            setProviders([])
            setLoadFailed(true)
          }
        },
      )
    else setProviders([])
    return () => {
      live = false
    }
  }, [hostId, readable, reload, refresh])
  useEffect(() => {
    if (!terminal) return
    const id = terminal.ptyId
    const unsubscribe = window.phosphor.onPtyExit(id, () => {
      setTerminal(null)
      void window.phosphor.invoke('hosts:providers', hostId).then(setProviders, () => {
        setError('Could not refresh provider readiness.')
      })
    })
    return () => {
      unsubscribe()
      void window.phosphor.invoke('pty:kill', id).catch(() => undefined)
    }
  }, [terminal, hostId])
  async function start(provider: string) {
    setBusy(true)
    setError(null)
    try {
      const result = await window.phosphor.invoke('hosts:providerLogin', hostId, provider)
      if (live.current && currentHost.current === hostId) setTerminal({ ...result, provider })
      else void window.phosphor.invoke('pty:kill', result.ptyId).catch(() => undefined)
    } catch {
      setError('Sign-in not confirmed. Check readiness before trying again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mt-4 space-y-3">
      {loadFailed && (
        <div role="alert" className="flex items-center justify-between gap-3">
          <span>Could not load this machine's providers.</span>
          <Button onClick={() => setReload((n) => n + 1)}>Retry</Button>
        </div>
      )}
      {providers
        .filter((p) => p.status === 'ready')
        .map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3">
            <span>{p.name}: Signed in</span>
          </div>
        ))}
      {providers
        .filter((p) => p.status === 'not_ready')
        .map((p) => {
          const provider = p.id === 'pi-claude-cli' ? 'claude' : p.id
          return (
            <div key={p.id} className="flex items-center justify-between gap-3">
              <span>{p.name}: Not signed in</span>
              {allowed ? (
                <Button disabled={busy || !!terminal} onClick={() => void start(provider)}>
                  Sign in
                </Button>
              ) : (
                <code>phosphor providers login {provider}</code>
              )}
            </div>
          )
        })}
      {error && <p role="alert">{error}</p>}
      {terminal && (
        <ModalOverlay onClose={() => setTerminal(null)}>
          <div role="dialog" aria-modal="true" aria-label="Provider sign-in">
            <ModalPanel
              width={800}
              title="Sign in on this machine"
              footer={<Button onClick={() => setTerminal(null)}>Close</Button>}
            >
              <p>
                Type /login {terminal.provider} in pi, follow its instructions, then /quit. For
                Claude, follow the printed login steps. Credentials stay on this machine.
              </p>
              <div className="h-96">
                <Suspense fallback={<p>Opening terminal...</p>}>
                  <TerminalView ptyId={terminal.ptyId} visible readOnly={!allowed} />
                </Suspense>
              </div>
            </ModalPanel>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}

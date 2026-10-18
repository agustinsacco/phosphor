import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
const TerminalView = lazy(() =>
  import('@/features/terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
)
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import type { MachineProvider } from '@shared/host-protocol-machine'
import { Skeleton, StatusPill } from './MachineUi'

const ORDER = { ready: 0, not_ready: 1, unknown: 2 } as const

/** Provider contents and credentials stay on the authenticated Host terminal connection. */
export function ProviderSignIn({
  hostId,
  refresh = 0,
  onConfigure,
}: {
  hostId: string
  refresh?: number
  onConfigure?: () => void
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
  // null while the first read is in flight.
  const [providers, setProviders] = useState<MachineProvider[] | null>(null)
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
    setProviders(null)
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
  const claude = terminal?.provider === 'claude'
  return (
    <div className="space-y-2">
      {loadFailed ? (
        <div role="alert" className="flex items-center justify-between gap-3 py-1 text-base">
          <span>Could not load this machine's providers.</span>
          <Button size="xs" onClick={() => setReload((n) => n + 1)}>
            Retry
          </Button>
        </div>
      ) : !readable ? (
        <p className="text-text-secondary text-base">
          Providers appear once this computer is connected to the machine.
        </p>
      ) : providers === null ? (
        <div role="status" aria-label="Loading providers" className="space-y-3 py-1">
          {[0, 1, 2].map((row) => (
            <div key={row} className="flex items-center gap-3">
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="ml-auto h-4 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ) : providers.length === 0 ? (
        <p className="text-text-secondary text-base">No providers reported by this machine.</p>
      ) : (
        <ul className="divide-border divide-y">
          {[...providers]
            .sort((a, b) => ORDER[a.status] - ORDER[b.status])
            .map((p) => {
              const provider = p.id === 'pi-claude-cli' ? 'claude' : p.id
              return (
                <li key={p.id} data-provider={p.id} className="flex items-center gap-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-lg">{p.name}</span>
                  <StatusPill
                    // Unused providers are not problems; the Sign in button is the action.
                    tone={p.status === 'ready' ? 'ok' : 'off'}
                  >
                    {p.status === 'ready'
                      ? 'Signed in'
                      : p.status === 'not_ready'
                        ? 'Not signed in'
                        : 'Not reported'}
                  </StatusPill>
                  {!onConfigure &&
                    p.status === 'not_ready' &&
                    (allowed ? (
                      <Button
                        size="xs"
                        disabled={busy || !!terminal}
                        onClick={() => void start(provider)}
                      >
                        Sign in
                      </Button>
                    ) : (
                      <code className="text-text-secondary font-mono text-sm">
                        phosphor providers login {provider}
                      </code>
                    ))}
                </li>
              )
            })}
        </ul>
      )}
      {onConfigure && (
        <Button size="sm" onClick={onConfigure}>
          Provider settings
        </Button>
      )}
      {error && (
        <p role="alert" className="text-danger text-base">
          {error}
        </p>
      )}
      {terminal && (
        <ModalOverlay onClose={() => setTerminal(null)}>
          <div role="dialog" aria-modal="true" aria-label="Provider sign-in">
            <ModalPanel
              width={800}
              title="Sign in on this machine"
              footer={<Button onClick={() => setTerminal(null)}>Close</Button>}
            >
              <p className="px-5 pt-4 text-base">
                {claude
                  ? 'Claude Code prints a link and asks for a code. Open the link on any computer, sign in, then paste the code here.'
                  : `Type /login ${terminal.provider} in pi, follow its instructions, then /quit.`}{' '}
                Credentials stay on this machine.
              </p>
              <div className="h-96 p-3">
                <Suspense fallback={<p>Opening terminal…</p>}>
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

import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { lazy, Suspense } from 'react'
import { StatusPill } from './MachineUi'
const TerminalView = lazy(() =>
  import('@/features/terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
)

import type { ProviderSignInState } from './useProviderSignIn'
const ORDER = { ready: 0, not_ready: 1, unknown: 2 } as const
export function ProviderReadinessList({
  state,
  onConfigure,
}: {
  state: ProviderSignInState
  onConfigure?: () => void
}): React.JSX.Element {
  const { providers, allowed, busy, terminal, start } = state
  return (
    <ul className="divide-border divide-y">
      {[...(providers ?? [])]
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
  )
}
export function ProviderSignInDialog({
  state,
}: {
  state: ProviderSignInState
}): React.JSX.Element | null {
  const { terminal, setTerminal, claude, allowed } = state
  if (!terminal) return null
  return (
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
  )
}

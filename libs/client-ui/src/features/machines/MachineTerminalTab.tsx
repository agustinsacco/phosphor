import { lazy, Suspense, useMemo } from 'react'
import { usePlatform } from '@/platform/Platform'
import { machineShellRefusal } from '@/stores/machineCaps'
import { machineTarget } from '@/stores/terminal'
import { useRemoteLanesStore } from '@/stores/remoteLanes'

// xterm belongs to the terminal, not to the Machines page: load it with the tab.
const TerminalPane = lazy(() =>
  import('@/features/terminal/TerminalPane').then((m) => ({ default: m.TerminalPane })),
)

/**
 * The machine's own tab: the Host account's login shell in its home folder,
 * outside any lane, drawn by the same pane every lane's terminal uses — the
 * same tabs, "+", rename, close and retry.
 *
 * Every device with control shares the one shell: opening it attaches to a
 * running shell before starting a new one, so "+" answers with the shell that
 * is already there. Leaving the tab leaves the shell running and reattaches on
 * return; closing its tab is what ends it.
 */
export function MachineTerminalTab({
  hostId,
  label,
}: {
  hostId: string
  label: string
}): React.JSX.Element {
  const platform = usePlatform()
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  // This computer's shell is main's own PTY manager: never refused by a Host.
  const refusal =
    hostId === 'local' && platform.localLanes ? null : machineShellRefusal(host, label)
  // Stable identity: TerminalPane is memoised and its first-open effect keys on the target.
  const target = useMemo(() => machineTarget(hostId, refusal), [hostId, refusal])
  return (
    <div
      data-testid="machine-terminal"
      className="border-border bg-surface h-[70vh] min-h-64 overflow-hidden rounded-lg border"
    >
      <Suspense
        fallback={
          <p role="status" className="text-text-secondary p-4">
            Loading terminal…
          </p>
        }
      >
        <TerminalPane target={target} />
      </Suspense>
    </div>
  )
}

import { lazy, Suspense, useEffect, useState } from 'react'
import { Button } from '@/components/form'
import { usePlatform } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { Card } from './MachineUi'

const TerminalView = lazy(() =>
  import('@/features/terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
)

/** Shell per Host for this window, so leaving the page and coming back reattaches. */
const opened = new Map<string, string>()

/** Why this device cannot open the machine's shell, or null when it can. */
export function machineShellRefusal(
  host: { state: string; capabilities: readonly string[]; machineShell?: boolean } | undefined,
  label: string,
): string | null {
  if (!host || host.state !== 'ready') return `Connect to ${label} to open a terminal.`
  if (!host.capabilities.includes('terminal') || !host.capabilities.includes('sessions.control'))
    return `This device may not open terminals on ${label}.`
  if (!host.machineShell) return `Update the Host on ${label} to open a terminal here.`
  return null
}

/** Open, hide and end the machine shell; the handle survives leaving the page. */
function useMachineShell(hostId: string) {
  const [ptyId, setPtyId] = useState<string | null>(() => opened.get(hostId) ?? null)
  const [exited, setExited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!ptyId) return
    return window.phosphor.onPtyExit(ptyId, () => {
      opened.delete(hostId)
      setExited(true)
    })
  }, [hostId, ptyId])
  async function open(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const { ptyId } = await window.phosphor.invoke('hosts:machineShell', hostId, 80, 24)
      opened.set(hostId, ptyId)
      setExited(false)
      setPtyId(ptyId)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open a terminal.')
    } finally {
      setBusy(false)
    }
  }
  function hide(): void {
    opened.delete(hostId)
    setPtyId(null)
  }
  async function end(): Promise<void> {
    try {
      if (ptyId) await window.phosphor.invoke('pty:kill', ptyId)
      hide()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not end the shell.')
    }
  }
  return { ptyId: exited ? null : ptyId, exited, busy, error, open, hide, end }
}

/**
 * The Host account's login shell in its home folder, outside any lane. Every
 * device with control shares the one shell: opening it attaches to a running
 * shell first. Hiding it leaves the shell running; End shell stops it.
 */
export function MachineTerminal({
  hostId,
  label,
}: {
  hostId: string
  label: string
}): React.JSX.Element | null {
  const platform = usePlatform()
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const shell = useMachineShell(hostId)
  if (!platform.terminal) return null
  const refusal =
    hostId === 'local' && platform.localLanes ? null : machineShellRefusal(host, label)
  const ptyId = refusal ? null : shell.ptyId
  return (
    <Card
      title="Terminal"
      aside={
        ptyId && (
          <>
            <Button size="sm" onClick={shell.hide}>
              Hide
            </Button>
            <Button size="sm" variant="danger" onClick={() => void shell.end()}>
              End shell
            </Button>
          </>
        )
      }
    >
      {refusal ? (
        <p className="text-text-secondary text-base">{refusal}</p>
      ) : ptyId ? (
        <div className="h-[60vh] min-h-64" data-testid="machine-terminal">
          <Suspense fallback={<p role="status">Loading…</p>}>
            <TerminalView ptyId={ptyId} visible />
          </Suspense>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-text-secondary min-w-0 flex-1 text-base">
            {shell.exited
              ? 'The shell exited.'
              : `A shell on ${label} in its home folder, outside any lane.`}
          </p>
          <Button size="sm" disabled={shell.busy} onClick={() => void shell.open()}>
            {shell.exited ? 'Start a new shell' : 'Open terminal'}
          </Button>
        </div>
      )}
      {shell.error && (
        <p role="alert" className="text-danger mt-2 text-sm">
          {shell.error}
        </p>
      )}
    </Card>
  )
}

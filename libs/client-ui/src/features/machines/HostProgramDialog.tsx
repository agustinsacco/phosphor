import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
const TerminalView = lazy(() =>
  import('@/features/terminal/TerminalView').then((m) => ({ default: m.TerminalView })),
)

/** An owner-private Host PTY. Closing cancels it; exit triggers authoritative verification. */
export function HostProgramDialog({
  hostLabel,
  title,
  instructions,
  ptyId,
  onClose,
  onSettled,
}: {
  hostLabel: string
  title: string
  instructions: string
  ptyId: string
  onClose(): void
  onSettled(): void
}): React.JSX.Element {
  const [exitCode, setExitCode] = useState<number | null>(null)
  const ended = exitCode !== null
  const settled = useRef(onSettled)
  settled.current = onSettled
  useEffect(() => {
    const off = window.phosphor.onPtyExit(ptyId, (code) => {
      setExitCode(code)
      settled.current()
    })
    return () => {
      off()
      void window.phosphor.invoke('pty:kill', ptyId).catch(() => {})
    }
  }, [ptyId])
  return (
    <ModalOverlay onClose={onClose}>
      <div role="dialog" aria-modal="true" aria-label={`${title} on ${hostLabel}`}>
        <ModalPanel
          width={850}
          title={`${title} on ${hostLabel}`}
          footer={<Button onClick={onClose}>{ended ? 'Done' : 'Cancel and close'}</Button>}
        >
          <div className="space-y-2 px-5 pt-4 text-base">
            <p>{instructions}</p>
            <p className="text-text-secondary">
              This terminal runs on {hostLabel}, not this computer. Credentials and settings stay
              there.
            </p>
            {ended && (
              <p role="status">
                Program exited{exitCode === 0 ? '.' : ` (code ${exitCode}).`} Settings are being
                re-read;
                {exitCode === 0
                  ? ' exit alone does not prove sign-in succeeded.'
                  : ' setup or authentication could not be verified. Check the Host status before retrying.'}
              </p>
            )}
          </div>
          <div className="h-96 p-3">
            <Suspense fallback={<p role="status">Opening private Host terminal…</p>}>
              <TerminalView ptyId={ptyId} visible readOnly={ended} />
            </Suspense>
          </div>
        </ModalPanel>
      </div>
    </ModalOverlay>
  )
}

import { lazy, Suspense, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'

// The previewer brings Monaco; the Machines page loads it only when files open.
const MachineFilesPane = lazy(() =>
  import('@/features/files/MachineFilesPane').then((module) => ({
    default: module.MachineFilesPane,
  })),
)

/** A Host's home folder, browsed read-only from its machine detail. */
export function MachineFilesButton({
  machine,
}: {
  machine: { id: string; label: string }
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <TooltipButton
        tooltip={`Browse files on ${machine.label}`}
        className="machine-view-tab text-base"
        onClick={() => setOpen(true)}
      >
        Machine files
      </TooltipButton>
      {open && (
        <ModalOverlay onClose={() => setOpen(false)}>
          <ModalPanel
            width={640}
            title="Machine files"
            footer={<Button onClick={() => setOpen(false)}>Close</Button>}
          >
            <div className="h-[65dvh]">
              <Suspense fallback={null}>
                <MachineFilesPane hostId={machine.id} />
              </Suspense>
            </div>
          </ModalPanel>
        </ModalOverlay>
      )}
    </>
  )
}

import { lazy, Suspense, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { UnderlinedTab } from '@/components/UnderlinedTabs'

// The previewer brings Monaco; the Machines page loads it only when files open.
const MachineFilesPane = lazy(() =>
  import('@/features/files/MachineFilesPane').then((module) => ({
    default: module.MachineFilesPane,
  })),
)

/** A machine's repositories or recent folders, browsed read-only from its machine detail. */
export function MachineFilesButton({
  machine,
}: {
  machine: { id: string; label: string }
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <UnderlinedTab tooltip={`Browse files on ${machine.label}`} onClick={() => setOpen(true)}>
        Machine files
      </UnderlinedTab>
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

import { ModalOverlay } from '@/components/Modal'
import { BrainSearch } from '../explorer/BrainSearch'
import type { BrainVisit } from '../explorer/trail'

/** Brain search over the page, opened with `/`: a person, a project or a memory. */
export function SearchPalette({
  onSelect,
  onClose,
}: {
  onSelect: (visit: BrainVisit) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <ModalOverlay align="top" onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search Brain"
        className="border-border bg-surface-raised mt-[12vh] w-[36rem] max-w-[92vw] rounded-lg border p-3 shadow-2xl"
      >
        <BrainSearch
          autoFocus
          onSelect={(visit) => {
            onSelect(visit)
            onClose()
          }}
        />
      </div>
    </ModalOverlay>
  )
}

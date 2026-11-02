import { lazy, Suspense } from 'react'
import type { InstructionsSource } from './instructionsSource'

// Monaco and the markdown renderer load when the editor first opens, not with Settings.
const InstructionsEditor = lazy(() =>
  import('./InstructionsEditor').then((m) => ({ default: m.InstructionsEditor })),
)

/** The global instructions editor for one machine, loaded on first open. */
export function EditInstructions({
  source,
  onClose,
}: {
  source: InstructionsSource
  onClose: () => void
}): React.JSX.Element {
  return (
    <Suspense fallback={null}>
      <InstructionsEditor source={source} onClose={onClose} />
    </Suspense>
  )
}

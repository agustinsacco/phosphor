import type { BrainEntityView } from '@shared/brain'
import { Button } from '@/components/form'
import { useBrain } from '../useBrain'
import type { MapStep } from '../map/SentenceMap'
import type { MapOverlay } from '../map/useSentenceMap'
import type { BrainVisit } from '../explorer/trail'
import { CardHeader } from './CardHeader'
import { CardMemories } from './CardMemories'
import { CardRelations, CardTogether } from './CardRelations'
import type { MemoryActions } from './MemoryOpen'

/**
 * The selected person or thing: its relationships now and before as sentences, what it is
 * named with but not linked to, and its memories. A sentence walks to the other end.
 */
export function BrainCard({
  view,
  error,
  retry,
  ownerId,
  onStep,
  onVisit,
  onOwner,
  onWhole,
  onLight,
  memoryActions,
}: {
  view: BrainEntityView | null
  error: string
  retry: () => void
  ownerId: string | null
  onStep: (step: MapStep) => void
  onVisit: (visit: BrainVisit) => void
  onOwner: (entityId: string | null) => void
  onWhole: () => void
  onLight: (overlay: MapOverlay) => void
  memoryActions: MemoryActions
}): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  if (!view)
    return (
      <p role="status" className="p-4 text-sm">
        {error || 'Loading…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  const count = Object.values(view.memoryCounts).reduce((sum, n) => sum + n, 0)
  return (
    <article aria-label={view.entity.label} className="space-y-4 p-4">
      <CardHeader
        view={view}
        owner={view.entity.id === ownerId}
        saving={saving}
        onOwner={onOwner}
        onVisit={onVisit}
        onWhole={onWhole}
        onLight={onLight}
      />
      <CardRelations view={view} onStep={onStep} />
      <CardTogether view={view} onStep={onStep} />
      <CardMemories
        key={view.entity.id}
        entityId={view.entity.id}
        count={count}
        actions={memoryActions}
      />
    </article>
  )
}

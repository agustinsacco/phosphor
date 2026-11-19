import { Button } from '@/components/form'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { ENTITY_WORDS } from '../memoryLabels'
import { KindDot } from '../explorer/KnowledgePrimitives'
import { useEntityView } from '../explorer/useEntityView'

/** At most this many cards: the people and things a decision is about, not their neighbours. */
const CARDS = 6

/** "What Brain knows": one compact card per existing person or thing the decision involves. */
export function InboxContext({
  entityIds,
  onEntity,
}: {
  entityIds: string[]
  onEntity: (id: string, label: string) => void
}): React.JSX.Element {
  const ids = [...new Set(entityIds)].slice(0, CARDS)
  return (
    <div className="min-w-0 p-2">
      <SectionLabel>What Brain knows</SectionLabel>
      {!ids.length && (
        <p className="text-text-tertiary p-2 text-sm">
          Nothing yet about the people and things in this decision.
        </p>
      )}
      {ids.map((id) => (
        <ContextCard key={id} id={id} onEntity={onEntity} />
      ))}
    </div>
  )
}

function ContextCard({
  id,
  onEntity,
}: {
  id: string
  onEntity: (id: string, label: string) => void
}): React.JSX.Element {
  const { data, error, retry } = useEntityView(id)
  if (!data)
    return (
      <p role="status" className="border-border border-b p-2 text-sm">
        {error || 'Loading…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  const { entity } = data
  return (
    <article aria-label={entity.label} className="border-border space-y-1 border-b p-2">
      <h3 className="flex items-start gap-2 font-medium">
        <KindDot kind={entity.kind} />
        <span className="min-w-0">
          {entity.label}{' '}
          <span className="text-text-tertiary text-sm font-normal">
            {ENTITY_WORDS[entity.kind]}
          </span>
        </span>
      </h3>
      {entity.description && <p className="text-text-secondary text-sm">{entity.description}</p>}
      <p className="text-text-tertiary text-sm">
        {formatCount(entity.memories, 'memory', 'memories')} ·{' '}
        {formatCount(entity.connections, 'link')}
      </p>
      <Button size="xs" onClick={() => onEntity(entity.id, entity.label)}>
        Open profile
      </Button>
    </article>
  )
}

import { useState } from 'react'
import type { BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { formatCount } from '@/lib/format'
import { ENTITY_WORDS } from '../memoryLabels'
import { ExplorerGraph } from './ExplorerGraph'
import { KindDot } from './KnowledgePrimitives'
import { useEntityView } from './useEntityView'
import { pageKeyTarget } from '../pageKeys'
import type { BrainVisit } from './trail'

/** Every person and thing in 3D, in the map's place. A click inspects; Open walks there. */
export function FullMap({
  entityId,
  label,
  path,
  onOpen,
  onClose,
}: {
  entityId: string | null
  label: string | undefined
  path: BrainLink[] | null
  /** Walk to this person or thing and leave the whole graph. */
  onOpen: (visit: BrainVisit) => void
  onClose: () => void
}): React.JSX.Element {
  const opened: BrainVisit | null = entityId
    ? { kind: 'entity', id: entityId, label: label ?? entityId }
    : null
  // The selection starts on the profile's own entity and can be cleared like any other.
  const [selected, setSelected] = useState<BrainVisit | null>(opened)
  const inspected = selected && selected.id !== entityId ? selected.id : null
  return (
    <section
      aria-label="Whole graph"
      className="relative flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => {
        if (!selected || !pageKeyTarget(event.nativeEvent, 'Escape')) return
        event.preventDefault()
        setSelected(null)
      }}
    >
      <header className="border-border flex items-center gap-2 border-b px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate font-mono text-xs font-medium tracking-wider uppercase">
          Whole graph
        </h2>
        <Button size="xs" onClick={onClose}>
          Back to the map
        </Button>
      </header>
      <ExplorerGraph
        entityId={selected?.id ?? null}
        label={selected?.label}
        path={path}
        onVisit={setSelected}
        onClear={() => setSelected(null)}
      />
      {inspected && (
        <Inspector
          key={inspected}
          id={inspected}
          onOpen={onOpen}
          onClose={() => setSelected(opened)}
        />
      )}
    </section>
  )
}

function Inspector({
  id,
  onOpen,
  onClose,
}: {
  id: string
  onOpen: (visit: BrainVisit) => void
  onClose: () => void
}): React.JSX.Element {
  const { data, error, retry } = useEntityView(id)
  return (
    <aside
      aria-label="Inspector"
      className="bg-surface-raised border-border absolute right-3 bottom-16 z-10 w-64 space-y-1.5 rounded-lg border p-3 text-sm shadow-lg"
    >
      {!data ? (
        <p role="status">
          {error || 'Loading…'}{' '}
          {error && (
            <Button size="xs" onClick={retry}>
              Retry
            </Button>
          )}
        </p>
      ) : (
        <>
          <h3 className="flex items-start gap-2 font-medium">
            <KindDot kind={data.entity.kind} />
            <span className="min-w-0">
              {data.entity.label}{' '}
              <span className="text-text-tertiary font-normal">
                {ENTITY_WORDS[data.entity.kind]}
              </span>
            </span>
          </h3>
          {data.entity.description && (
            <p className="text-text-secondary">{data.entity.description}</p>
          )}
          <p className="text-text-tertiary">
            {formatCount(data.entity.memories, 'memory', 'memories')} ·{' '}
            {formatCount(data.entity.connections, 'link')}
          </p>
        </>
      )}
      <div className="flex gap-1.5 pt-1">
        <Button
          size="xs"
          variant="primary"
          disabled={!data}
          onClick={() => data && onOpen({ kind: 'entity', id, label: data.entity.label })}
        >
          Go there
        </Button>
        <Button size="xs" onClick={onClose}>
          Close
        </Button>
      </div>
    </aside>
  )
}

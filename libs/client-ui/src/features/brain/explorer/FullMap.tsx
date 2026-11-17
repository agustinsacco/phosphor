import { useState } from 'react'
import type { BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { formatCount } from '@/lib/format'
import { ENTITY_WORDS } from '../memoryLabels'
import { ExplorerGraph } from './ExplorerGraph'
import { KindDot } from './KnowledgePrimitives'
import { useEntityView } from './useEntityView'
import type { BrainVisit } from './trail'

/** The whole graph in 3D, given the width of profile and map. A click inspects; it never walks. */
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
  /** Open this person or thing's profile and leave the full map. */
  onOpen: (visit: BrainVisit) => void
  onClose: () => void
}): React.JSX.Element {
  const [inspected, setInspected] = useState<string | null>(null)
  return (
    <section aria-label="Full map" className="relative flex min-h-0 flex-1 flex-col">
      <header className="border-border flex items-center gap-2 border-b px-3 py-1.5">
        <h2 className="min-w-0 flex-1 truncate font-mono text-xs font-medium tracking-wider uppercase">
          Full map
        </h2>
        <Button size="xs" onClick={onClose}>
          Back to profile
        </Button>
      </header>
      <ExplorerGraph
        entityId={inspected ?? entityId}
        label={label}
        path={path}
        onVisit={(visit) => setInspected(visit.id)}
        onClear={() => setInspected(null)}
      />
      {inspected && (
        <Inspector
          key={inspected}
          id={inspected}
          onOpen={onOpen}
          onClose={() => setInspected(null)}
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
          Open profile
        </Button>
        <Button size="xs" onClick={onClose}>
          Close
        </Button>
      </div>
    </aside>
  )
}

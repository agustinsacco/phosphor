import { useCallback, useState } from 'react'
import type { BrainEntity, BrainPaths, BrainLink } from '@shared/brain'
import { TooltipButton } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { MergeEntity } from './MergeEntity'
import { useBrainResource } from '../useBrainResource'
import { BrainSearch } from './BrainSearch'
import { EntityChip } from './KnowledgePrimitives'
import type { BrainVisit } from './trail'

/** Under the profile header: search for the other end of a route or a merge. */
export function ProfileToolPanel({
  entity,
  tool,
  onClose,
  onVisit,
  onPath,
}: {
  entity: BrainEntity
  tool: 'route' | 'merge'
  onClose: () => void
  onVisit: (visit: BrainVisit) => void
  onPath: (path: BrainLink[] | null) => void
}): React.JSX.Element {
  const [target, setTarget] = useState<BrainVisit | null>(null)
  return (
    <section
      aria-label={tool === 'route' ? 'Find route' : 'Merge into'}
      className="border-border bg-bg-secondary space-y-3 rounded-md border p-3"
    >
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 font-medium">
          {tool === 'route'
            ? `Find a route from ${entity.label} to…`
            : `Merge ${entity.label} into…`}
        </h3>
        <Button
          size="xs"
          onClick={() => {
            onPath(null)
            onClose()
          }}
        >
          Close
        </Button>
      </div>
      <BrainSearch entitiesOnly exclude={entity.id} onSelect={setTarget} />
      {tool === 'merge' && target && (
        <MergeEntity key={target.id} sourceId={entity.id} target={target} onVisit={onVisit} />
      )}
      {tool === 'route' && target && (
        <PathResults
          key={target.id}
          from={entity.id}
          to={target.id}
          onVisit={onVisit}
          onPath={onPath}
        />
      )}
    </section>
  )
}

function PathResults({
  from,
  to,
  onVisit,
  onPath,
}: {
  from: string
  to: string
  onVisit: (visit: BrainVisit) => void
  onPath: (path: BrainLink[] | null) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:path', from, to), [from, to])
  const { data, error, retry } = useBrainResource(load)
  const [selected, setSelected] = useState<number | null>(null)
  if (!data)
    return (
      <p role="status">
        {error || 'Finding supported routes…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  return (
    <section aria-label="Supported routes" className="space-y-3">
      {!data.paths.length && <p>No supported route within four steps.</p>}
      {data.paths.map((path, index) => (
        <article key={index} className="border-border space-y-2 rounded border p-2">
          <Button
            size="xs"
            aria-pressed={selected === index}
            tooltip="Show this route on the full map"
            onClick={() => {
              setSelected(index)
              onPath(path)
            }}
          >
            Show route {index + 1} on the map
          </Button>
          <PathChain data={data} path={path} onVisit={onVisit} />
        </article>
      ))}
    </section>
  )
}

export function PathChain({
  data,
  path,
  onVisit,
}: {
  data: BrainPaths
  path: BrainPaths['paths'][number]
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const entity = (id: string): React.ReactNode => {
    const found = data.entities.find((e) => e.id === id)
    const label = found?.label ?? id
    return (
      <EntityChip
        label={label}
        kind={found?.kind}
        onClick={() => onVisit({ kind: 'entity', id, label })}
      />
    )
  }
  return (
    <ol className="space-y-2">
      {path.map((link) => (
        <li key={link.id}>
          <p>
            {entity(link.subjectId)} → {link.predicate.replaceAll('_', ' ')} →{' '}
            {entity(link.objectId)}
          </p>
          <TooltipButton
            className="brain-row"
            onClick={() =>
              onVisit({
                kind: 'memory',
                id: link.memoryId,
                label: data.memories.find((m) => m.id === link.memoryId)?.summary ?? 'Memory',
              })
            }
          >
            {data.memories.find((m) => m.id === link.memoryId)?.summary ?? 'Open supporting memory'}
          </TooltipButton>
        </li>
      ))}
    </ol>
  )
}

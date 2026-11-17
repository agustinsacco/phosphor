import { useCallback, useState } from 'react'
import type { BrainEntity, BrainPaths, BrainLink } from '@shared/brain'
import { TooltipButton } from '@/components/Tooltip'
import { MergeEntity } from './MergeEntity'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { BrainSearch } from './BrainSearch'
import type { BrainVisit } from './trail'

export function EntityActions({
  entity,
  onVisit,
  onPath,
}: {
  entity: BrainEntity
  onVisit: (visit: BrainVisit) => void
  onPath: (path: BrainLink[] | null) => void
}): React.JSX.Element {
  const [mode, setMode] = useState<'path' | 'merge' | null>(null)
  const [target, setTarget] = useState<BrainVisit | null>(null)
  const saving = useBrain((s) => s.saving)
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <TooltipButton
          className="text-text-secondary text-left hover:underline"
          onClick={() => {
            setMode('path')
            setTarget(null)
            onPath(null)
          }}
        >
          Find route to…
        </TooltipButton>
        <TooltipButton
          className="text-text-secondary text-left hover:underline"
          disabled={saving}
          onClick={() => {
            setMode('merge')
            setTarget(null)
            onPath(null)
          }}
        >
          Merge into…
        </TooltipButton>
        {mode && (
          <TooltipButton
            className="text-text-secondary text-left hover:underline"
            onClick={() => {
              setMode(null)
              setTarget(null)
              onPath(null)
            }}
          >
            Close {mode === 'path' ? 'path finder' : 'merge'}
          </TooltipButton>
        )}
      </div>
      {mode && <BrainSearch entitiesOnly exclude={entity.id} onSelect={setTarget} />}
      {mode === 'merge' && target && (
        <MergeEntity key={target.id} sourceId={entity.id} target={target} onVisit={onVisit} />
      )}
      {mode === 'path' && target && (
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
        {error || 'Finding supported paths…'}
        {error && <TooltipButton onClick={retry}>Retry</TooltipButton>}
      </p>
    )
  return (
    <section aria-label="Supported paths" className="space-y-3">
      {!data.paths.length && <p>No supported path found within four hops.</p>}
      {data.paths.map((path, index) => (
        <article key={index} className="border-border space-y-2 rounded border p-2">
          <TooltipButton
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index)
              onPath(path)
            }}
          >
            Highlight route {index + 1}
          </TooltipButton>
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
    const label = data.entities.find((e) => e.id === id)?.label ?? id
    return (
      <TooltipButton onClick={() => onVisit({ kind: 'entity', id, label })}>{label}</TooltipButton>
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

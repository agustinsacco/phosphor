import { useCallback, useState } from 'react'
import type { BrainEntity, BrainPaths, BrainLink } from '@shared/brain'
import { Button } from '@/components/form'
import { promptText } from '@/stores/prompt'
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
        <Button
          size="sm"
          onClick={() => {
            setMode('path')
            setTarget(null)
            onPath(null)
          }}
        >
          Find a path to…
        </Button>
        <Button
          size="sm"
          disabled={saving}
          onClick={() => {
            setMode('merge')
            setTarget(null)
            onPath(null)
          }}
        >
          Merge into…
        </Button>
        {mode && (
          <Button
            size="sm"
            onClick={() => {
              setMode(null)
              setTarget(null)
              onPath(null)
            }}
          >
            Close {mode === 'path' ? 'path finder' : 'merge'}
          </Button>
        )}
      </div>
      {mode && (
        <BrainSearch
          entitiesOnly
          exclude={entity.id}
          onSelect={(visit) => {
            if (mode === 'merge') void mergeEntity(entity, visit, onVisit)
            else setTarget(visit)
          }}
        />
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
        {error && <Button onClick={retry}>Retry</Button>}
      </p>
    )
  return (
    <section aria-label="Supported paths" className="space-y-3">
      {!data.paths.length && <p>No supported path found within four hops.</p>}
      {data.paths.map((path, index) => (
        <article key={index} className="border-border space-y-2 rounded border p-2">
          <Button
            size="xs"
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index)
              onPath(path)
            }}
          >
            Highlight route {index + 1}
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
    const label = data.entities.find((e) => e.id === id)?.label ?? id
    return (
      <Button size="xs" onClick={() => onVisit({ kind: 'entity', id, label })}>
        {label}
      </Button>
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
          <Button
            size="xs"
            className="text-left"
            onClick={() =>
              onVisit({
                kind: 'memory',
                id: link.memoryId,
                label: data.memories.find((m) => m.id === link.memoryId)?.summary ?? 'Memory',
              })
            }
          >
            {data.memories.find((m) => m.id === link.memoryId)?.summary ?? 'Open supporting memory'}
          </Button>
        </li>
      ))}
    </ol>
  )
}

async function mergeEntity(
  entity: BrainEntity,
  visit: BrainVisit,
  onVisit: (visit: BrainVisit) => void,
): Promise<void> {
  const answer = await promptText({
    title: `Merge ${entity.label} into ${visit.label}?`,
    message:
      'All names, links and memories move to the target. The source entity is deleted. This cannot be undone. Type MERGE to confirm.',
    submitLabel: 'Merge',
    placeholder: 'MERGE',
  })
  if (answer !== 'MERGE') return
  if (await useBrain.getState().merge(entity.id, visit.id)) onVisit(visit)
}

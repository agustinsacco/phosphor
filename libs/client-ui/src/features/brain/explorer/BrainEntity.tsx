import { formatCount } from '@/lib/format'
import { useCallback, useEffect, useRef, useState } from 'react'
import { BRAIN_PREDICATE_LABELS, type BrainLink, type BrainConnectionGroup } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button, Tag } from '@/components/form'
import { useBrainResource } from '../useBrainResource'
import { EntityMemories } from './EntityMemories'
import { EntityChip } from './KnowledgePrimitives'
import type { BrainVisit } from './trail'
import { EntityActions } from './EntityActions'

export function BrainEntity({
  id,
  onVisit,
  onPath,
}: {
  id: string
  onVisit: (visit: BrainVisit) => void
  onPath: (path: BrainLink[] | null) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:entity', id), [id])
  const { data, error, retry } = useBrainResource(load)
  if (!data)
    return (
      <p role="status" className="p-3">
        {error || 'Loading entity…'}
        {error && <Button onClick={retry}>Retry</Button>}
      </p>
    )
  return (
    <article aria-label="Entity detail" className="min-w-0 space-y-4 py-3">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-xl font-semibold">{data.entity.label}</h2>
          <Tag>{data.entity.kind}</Tag>
        </div>
        <p className="text-text-tertiary text-sm">
          {formatCount(data.entity.memories, 'memory', 'memories')}
        </p>
      </header>
      <p>{data.entity.description}</p>
      {data.entity.aliases.length > 0 && <p>Also known as: {data.entity.aliases.join(', ')}</p>}
      {data.merged.length > 0 && <p>Merged labels: {data.merged.join(', ')}</p>}
      <p className="text-text-tertiary text-sm">
        Source lanes: {data.sources.map((s) => s.title).join(', ') || 'None'}
      </p>
      <EntityActions entity={data.entity} onVisit={onVisit} onPath={onPath} />
      <section aria-label="Connections">
        <h3 className="font-medium">Connections</h3>
        {!data.groups.length && <p>No connections yet</p>}
        {data.groups.map((group) => (
          <Connections
            key={`${group.direction}:${group.predicate}`}
            id={id}
            group={group}
            onVisit={onVisit}
          />
        ))}
      </section>
      <EntityMemories id={id} sources={data.sources} counts={data.memoryCounts} onVisit={onVisit} />
    </article>
  )
}

function Connections({
  id,
  group,
  onVisit,
}: {
  id: string
  group: BrainConnectionGroup
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [items, setItems] = useState(group.items)
  const [next, setNext] = useState(group.next)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const more = async (): Promise<void> => {
    setLoading(true)
    setError('')
    try {
      const page = await window.phosphor.invoke(
        'brain:connections',
        id,
        group.predicate,
        group.direction,
        next,
      )
      if (alive.current) {
        setItems((old) => [...old, ...page.items])
        setNext(page.next)
      }
    } catch (cause) {
      if (alive.current) setError(ipcErrorText(cause))
    } finally {
      if (alive.current) setLoading(false)
    }
  }
  return (
    <section className="mt-3 space-y-2">
      <h4 className="text-text-tertiary text-sm">
        {BRAIN_PREDICATE_LABELS[group.predicate][group.direction]} · {group.total}
      </h4>
      <div className="flex flex-wrap gap-1">
        {items.map(({ entity, link }) => (
          <EntityChip
            key={link.id}
            label={entity.label}
            kind={entity.kind}
            onClick={() => onVisit({ kind: 'entity', id: entity.id, label: entity.label })}
          />
        ))}
      </div>
      {error && <p role="status">{error}</p>}
      {next && (
        <Button
          size="xs"
          disabled={loading}
          onClick={() => {
            void more()
          }}
        >
          {loading ? 'Loading…' : error ? 'Retry' : 'Show more'}
        </Button>
      )}
    </section>
  )
}

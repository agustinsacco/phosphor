import { useCallback, useEffect, useRef, useState } from 'react'
import {
  BRAIN_MEMORY_TYPES,
  BRAIN_PREDICATE_LABELS,
  type BrainLink,
  type BrainConnectionGroup,
  type BrainEntityView,
  type BrainMemoryFilter,
  type BrainMemoryState,
} from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button, Select } from '@/components/form'
import { useBrainResource } from '../useBrainResource'
import { MEMORY_LABELS } from '../BrainMemory'
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
    <article aria-label="Entity detail" className="space-y-4 p-3">
      <header>
        <h2 className="text-xl font-semibold">{data.entity.label}</h2>
        <p className="text-text-tertiary text-sm">
          {data.entity.kind} · {data.entity.memories} memories
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
      <EntityMemories id={id} sources={data.sources} onVisit={onVisit} />
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
          <Button
            size="xs"
            key={link.id}
            onClick={() => onVisit({ kind: 'entity', id: entity.id, label: entity.label })}
          >
            {entity.label}
          </Button>
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

function EntityMemories({
  id,
  sources,
  onVisit,
}: {
  id: string
  sources: BrainEntityView['sources']
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [type, setType] = useState('')
  const [lane, setLane] = useState('')
  const [state, setState] = useState('')
  const [superseded, setSuperseded] = useState(false)
  const filter: BrainMemoryFilter = {
    types: type ? [type as (typeof BRAIN_MEMORY_TYPES)[number]] : undefined,
    states: [
      ...(state ? [state as BrainMemoryState] : (['active', 'disputed'] as BrainMemoryState[])),
      ...(superseded ? ['superseded' as const] : []),
    ],
    sessionId: lane || undefined,
  }
  return (
    <section aria-label="Entity memories" className="space-y-3">
      <h3 className="font-medium">Memories</h3>
      <div className="flex flex-wrap gap-2">
        <Select
          label="Memory type"
          value={type}
          onChange={setType}
          options={[
            { value: '', label: 'All types' },
            ...BRAIN_MEMORY_TYPES.map((t) => ({ value: t, label: MEMORY_LABELS[t] })),
          ]}
        />
        <Select
          label="Source lane"
          value={lane}
          onChange={setLane}
          options={[
            { value: '', label: 'All lanes' },
            ...sources.map((s) => ({ value: s.sessionId, label: s.title })),
          ]}
        />
        <Select
          label="Memory state"
          value={state}
          onChange={setState}
          options={[
            { value: '', label: 'Active and disputed' },
            { value: 'active', label: 'Active' },
            { value: 'disputed', label: 'Disputed' },
          ]}
        />
        <label className="text-sm">
          <input
            type="checkbox"
            checked={superseded}
            onChange={(e) => setSuperseded(e.target.checked)}
          />{' '}
          Include superseded
        </label>
      </div>
      <MemoryPages key={JSON.stringify([id, filter])} id={id} filter={filter} onVisit={onVisit} />
    </section>
  )
}

function MemoryPages({
  id,
  filter,
  onVisit,
}: {
  id: string
  filter: BrainMemoryFilter
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [cursor, setCursor] = useState<string | null>(null)
  const load = useCallback(
    () => window.phosphor.invoke('brain:entityMemories', id, filter, cursor),
    [id, filter, cursor],
  )
  const { data, error, retry } = useBrainResource(load)
  const [previous, setPrevious] = useState<NonNullable<typeof data>['memories']>([])
  const memories = [...previous, ...(data?.memories ?? [])]
  return (
    <div className="space-y-3">
      {BRAIN_MEMORY_TYPES.map((type) => {
        const group = memories.filter((m) => m.type === type)
        return (
          group.length > 0 && (
            <section key={type}>
              <h4 className="text-text-tertiary text-sm">{MEMORY_LABELS[type]}</h4>
              {group.map((m) => (
                <Button
                  key={m.id}
                  size="sm"
                  className="mb-1 block w-full text-left"
                  onClick={() => onVisit({ kind: 'memory', id: m.id, label: m.summary })}
                >
                  {m.summary} <span className="text-text-tertiary">· {m.state}</span>
                </Button>
              ))}
            </section>
          )
        )
      })}
      {!data && (
        <p role="status">
          {error || 'Loading memories…'}
          {error && <Button onClick={retry}>Retry</Button>}
        </p>
      )}
      {data && !memories.length && <p>No memories match these filters</p>}
      {data?.next && (
        <Button
          size="sm"
          onClick={() => {
            setPrevious(memories)
            setCursor(data.next)
          }}
        >
          Show more memories
        </Button>
      )}
    </div>
  )
}

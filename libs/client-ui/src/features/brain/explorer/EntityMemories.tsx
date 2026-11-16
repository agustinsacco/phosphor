import { useCallback, useState } from 'react'
import {
  BRAIN_MEMORY_TYPES,
  type BrainEntityView,
  type BrainMemoryFilter,
  type BrainMemoryState,
} from '@shared/brain'
import { Button, Select, Tag, NeutralSegmented } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { useBrainResource } from '../useBrainResource'
import { MEMORY_LABELS } from '../BrainMemory'
import type { BrainVisit } from './trail'
export function EntityMemories({
  id,
  sources,
  counts,
  onVisit,
}: {
  id: string
  sources: BrainEntityView['sources']
  counts: BrainEntityView['memoryCounts']
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
        <NeutralSegmented
          wrap
          value={type}
          onChange={setType}
          options={[
            { id: '', label: `All ${Object.values(counts).reduce((a, b) => a + b, 0)}` },
            ...BRAIN_MEMORY_TYPES.filter((t) => counts[t] > 0).map((t) => ({
              id: t,
              label: `${MEMORY_LABELS[t]} ${counts[t]}`,
            })),
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
  const memories = [
    ...new Map([...previous, ...(data?.memories ?? [])].map((m) => [m.id, m])).values(),
  ]
  return (
    <div className="space-y-3">
      {BRAIN_MEMORY_TYPES.map((type) => {
        const group = memories.filter((m) => m.type === type)
        return (
          group.length > 0 && (
            <section key={type}>
              <h4 className="text-text-tertiary text-sm">{MEMORY_LABELS[type]}</h4>
              {group.map((m) => (
                <TooltipButton
                  key={m.id}
                  className="brain-row"
                  onClick={() => onVisit({ kind: 'memory', id: m.id, label: m.summary })}
                >
                  <Tag>{m.type}</Tag>
                  <span className="min-w-0">
                    {m.summary} <span className="text-text-tertiary">· {m.state}</span>
                  </span>
                </TooltipButton>
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

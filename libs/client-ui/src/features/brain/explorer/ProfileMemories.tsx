import { useCallback, useState } from 'react'
import clsx from 'clsx'
import {
  BRAIN_MEMORY_TYPES,
  type BrainEntityView,
  type BrainMemory,
  type BrainMemoryFilter,
  type BrainMemoryType,
} from '@shared/brain'
import { Button, Select } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { MEMORY_LABELS } from '../memoryLabels'
import { MEMORY_TYPE_ORDER } from '../memoryLabels'
import { MemoryOpen, MemoryRow, type MemoryRowActions } from './MemoryRow'
import { brainLaneTitle } from '../laneTitle'

/** The Lane filter: every lane this entity's memories came from. */
function laneOptions(view: BrainEntityView): { value: string; label: string }[] {
  return [
    { value: '', label: 'All lanes' },
    ...view.sources.map((source) => ({
      value: source.sessionId,
      label: brainLaneTitle(source.title),
    })),
  ]
}

export interface MemoryFilters {
  type: BrainMemoryType | ''
  lane: string
  replaced: boolean
}
export const NO_MEMORY_FILTERS: MemoryFilters = { type: '', lane: '', replaced: false }

/** The Memories tab: a filter row that stays, then rows newest first, paged as Brain sends them. */
export function ProfileMemories({
  view,
  openId,
  onOpen,
  filters,
  onFilters,
  actions,
}: {
  view: BrainEntityView
  openId: string | null
  onOpen: (id: string | null) => void
  filters: MemoryFilters
  onFilters: (filters: MemoryFilters) => void
  actions: MemoryRowActions
}): React.JSX.Element {
  const revision = useBrain((s) => `${s.status?.generation}:${s.status?.revision}`)
  const counts = view.memoryCounts
  const all = BRAIN_MEMORY_TYPES.reduce((sum, type) => sum + counts[type], 0)
  const filter: BrainMemoryFilter = {
    types: filters.type ? [filters.type] : undefined,
    states: filters.replaced ? ['active', 'disputed', 'superseded'] : ['active', 'disputed'],
    sessionId: filters.lane || undefined,
  }
  return (
    <section aria-label="Memories" className="min-w-0">
      <div className="bg-bg border-border sticky top-0 z-10 space-y-1.5 border-b py-2">
        <div role="group" aria-label="Memory types" className="flex flex-wrap gap-1">
          <TypeChip
            pressed={!filters.type}
            label="All"
            count={all}
            onClick={() => onFilters({ ...filters, type: '' })}
          />
          {MEMORY_TYPE_ORDER.filter((type) => counts[type] > 0).map((type) => (
            <TypeChip
              key={type}
              pressed={filters.type === type}
              label={MEMORY_LABELS[type]}
              count={counts[type]}
              onClick={() => onFilters({ ...filters, type })}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Lane"
            value={filters.lane}
            onChange={(lane) => onFilters({ ...filters, lane })}
            className="px-1.5 py-0.5 text-sm"
            options={laneOptions(view)}
          />
          <Select
            label="State"
            value={filters.replaced ? 'all' : 'current'}
            onChange={(value) => onFilters({ ...filters, replaced: value === 'all' })}
            className="px-1.5 py-0.5 text-sm"
            options={[
              { value: 'current', label: 'Current' },
              { value: 'all', label: 'Include replaced' },
            ]}
          />
        </div>
      </div>
      <MemoryPages
        // A change in Brain restarts paging rather than keeping rows it may have removed.
        key={JSON.stringify([view.entity.id, filter, revision])}
        id={view.entity.id}
        filter={filter}
        openId={openId}
        onOpen={onOpen}
        actions={actions}
      />
    </section>
  )
}

function TypeChip({
  pressed,
  label,
  count,
  onClick,
}: {
  pressed: boolean
  label: string
  count: number
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      aria-pressed={pressed}
      onClick={onClick}
      className={clsx(
        'rounded-full px-2 py-0.5 text-sm',
        pressed ? 'bg-text text-bg' : 'bg-chip text-text-secondary hover:text-text',
      )}
    >
      {label}
      <span className="ml-1 opacity-70">{count}</span>
    </TooltipButton>
  )
}

function MemoryPages({
  id,
  filter,
  openId,
  onOpen,
  actions,
}: {
  id: string
  filter: BrainMemoryFilter
  openId: string | null
  onOpen: (id: string | null) => void
  actions: MemoryRowActions
}): React.JSX.Element {
  const { data, error, retry, memories, more } = useMemoryPages(id, filter)
  const listed = memories.some((memory) => memory.id === openId)
  return (
    <div className="space-y-2 pt-2">
      {openId && !listed && data && (
        <div aria-label="Opened memory" className="border-border rounded-md border p-2">
          <MemoryOpen id={openId} selfId={id} actions={actions} />
          <Button size="xs" onClick={() => onOpen(null)}>
            Close
          </Button>
        </div>
      )}
      {data && (
        <p className="text-text-tertiary text-sm">
          {memories.length}
          {data.next ? '+' : ''} shown · newest first
        </p>
      )}
      <ul>
        {memories.map((memory) => (
          <MemoryRow
            key={memory.id}
            memory={memory}
            selfId={id}
            open={memory.id === openId}
            onToggle={() => onOpen(memory.id === openId ? null : memory.id)}
            actions={actions}
          />
        ))}
      </ul>
      {!data && (
        <p role="status" className="text-sm">
          {error || 'Loading memories…'}{' '}
          {error && (
            <Button size="xs" onClick={retry}>
              Retry
            </Button>
          )}
        </p>
      )}
      {data && !memories.length && (
        <p className="text-text-tertiary text-sm">
          No memories match these filters. Choose All, All lanes or Include replaced.
        </p>
      )}
      {data?.next && (
        <Button size="xs" onClick={more}>
          Show more memories
        </Button>
      )}
    </div>
  )
}

/** Rows from every page loaded so far, newest first; a new page appends without repeats. */
function useMemoryPages(id: string, filter: BrainMemoryFilter) {
  const [cursor, setCursor] = useState<string | null>(null)
  const filterKey = JSON.stringify(filter)
  const load = useCallback(
    () =>
      window.phosphor.invoke(
        'brain:entityMemories',
        id,
        JSON.parse(filterKey) as BrainMemoryFilter,
        cursor,
      ),
    [id, filterKey, cursor],
  )
  const { data, error, retry } = useBrainResource(load)
  const [previous, setPrevious] = useState<BrainMemory[]>([])
  const memories = [
    ...new Map([...previous, ...(data?.memories ?? [])].map((m) => [m.id, m])).values(),
  ]
  return {
    data,
    error,
    retry,
    memories,
    more: (): void => {
      setPrevious(memories)
      setCursor(data?.next ?? null)
    },
  }
}

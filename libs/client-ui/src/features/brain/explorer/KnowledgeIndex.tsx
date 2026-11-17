import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { BRAIN_ENTITY_KINDS, type BrainEntityKind } from '@shared/brain'
import { Button, Select, TextInput } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { useBrain } from '../useBrain'
import { ENTITY_LABELS } from '../memoryLabels'
import { useBrainFind } from './BrainSearch'
import { KindDot } from './KnowledgePrimitives'
import { useEntityPages } from './useEntityPages'
import { ENTITY_SORT_LABELS, type EntitySort } from './entityIndex'
import type { BrainVisit } from './trail'

interface IndexRow {
  visit: BrainVisit
  kind: BrainEntityKind | null
  meta: string
}

/** The fixed index: search, kinds, sort, then compact rows. Only the rows scroll. */
export function KnowledgeIndex({
  selectedId,
  searchRequest,
  onVisit,
}: {
  selectedId: string | null
  searchRequest: number
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<BrainEntityKind | ''>('')
  const [sort, setSort] = useState<EntitySort>('connected')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  useEffect(() => {
    if (searchRequest) input.current?.focus()
  }, [searchRequest])
  const searching = !!query.trim()
  const find = useBrainFind(query)
  const browse = useEntityPages(kind || null, sort, !searching)
  const total = useBrain((s) => s.status?.counts.entities ?? 0)
  const entities: IndexRow[] = searching
    ? (find.data?.entities ?? [])
        .filter((entity) => !kind || entity.kind === kind)
        .map((entity) => ({
          visit: { kind: 'entity', id: entity.id, label: entity.label },
          kind: entity.kind,
          meta: String(entity.memories),
        }))
    : (browse.data?.items ?? []).map(({ entity, memories }) => ({
        visit: { kind: 'entity', id: entity.id, label: entity.label },
        kind: entity.kind,
        meta: String(memories),
      }))
  const memories: IndexRow[] = searching
    ? (find.data?.memories ?? []).map((memory) => ({
        visit: { kind: 'memory', id: memory.id, label: memory.summary },
        kind: null,
        meta: '',
      }))
    : []
  const rows = [...entities, ...memories]
  const choose = (visit: BrainVisit): void => {
    onVisit(visit)
    setActive(-1)
  }
  const onKey = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      setQuery('')
      setActive(-1)
      input.current?.blur()
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((value) => Math.max(0, Math.min(rows.length - 1, value + step)))
    } else if (event.key === 'Enter' && rows[Math.max(0, active)]) {
      event.preventDefault()
      choose(rows[Math.max(0, active)]!.visit)
    }
  }
  const counts = browse.data?.counts ?? {}
  const kinds = BRAIN_ENTITY_KINDS.filter((k) => (browse.data?.kinds ?? []).includes(k))
  const countAll = Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0) || total
  const resultLine = searching
    ? find.data
      ? formatCount(rows.length, 'result')
      : 'Searching…'
    : browse.data
      ? browse.data.total !== null
        ? formatCount(browse.data.total, 'result')
        : `${browse.data.items.length}${browse.data.more ? '+' : ''} shown`
      : 'Loading…'
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-border space-y-2 border-b p-2">
        <TextInput
          ref={input}
          role="combobox"
          aria-label="Search people, things, memories"
          placeholder="Search people, things, memories"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={rows.length > 0}
          aria-activedescendant={active >= 0 && rows[active] ? `${listId}-${active}` : undefined}
          value={query}
          className="w-full"
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(-1)
          }}
          onKeyDown={onKey}
        />
        <div role="group" aria-label="Kinds" className="flex flex-wrap gap-1">
          <KindChip pressed={!kind} onClick={() => setKind('')} label="All" count={countAll} />
          {kinds.map((k) => (
            <KindChip
              key={k}
              pressed={kind === k}
              onClick={() => setKind(k)}
              label={ENTITY_LABELS[k]}
              count={counts[k]}
            />
          ))}
        </div>
        <div className="text-text-tertiary flex items-center justify-between gap-2 text-sm">
          <span role="status">{resultLine}</span>
          {searching ? (
            <span>By best match</span>
          ) : (
            <Select
              label="Sort"
              value={sort}
              onChange={setSort}
              className="border-0 bg-transparent px-1 py-0 text-sm"
              options={(Object.keys(ENTITY_SORT_LABELS) as EntitySort[]).map((value) => ({
                value,
                label: ENTITY_SORT_LABELS[value],
              }))}
            />
          )}
        </div>
      </div>
      <div className="brain-scroll p-1">
        <div id={listId} role="listbox" aria-label="People and things">
          {entities.map((row, index) => (
            <IndexOption
              key={row.visit.id}
              row={row}
              id={`${listId}-${index}`}
              active={index === active}
              current={row.visit.id === selectedId}
              onChoose={choose}
            />
          ))}
          {memories.length > 0 && (
            <div role="group" aria-label="Memories">
              <SectionLabel>Memories</SectionLabel>
              {memories.map((row, index) => (
                <IndexOption
                  key={row.visit.id}
                  row={row}
                  id={`${listId}-${entities.length + index}`}
                  active={entities.length + index === active}
                  current={false}
                  onChoose={choose}
                />
              ))}
            </div>
          )}
        </div>
        <IndexState
          searching={searching}
          empty={!rows.length}
          error={searching ? find.error : browse.error}
          loaded={searching ? !!find.data : !!browse.data}
          retry={searching ? find.retry : browse.retry}
          more={!searching && !!browse.data?.more}
          onMore={browse.more}
        />
        {find.data?.degradation.map((note) => (
          <p key={note} className="text-text-tertiary p-2 text-sm">
            {note}
          </p>
        ))}
      </div>
    </div>
  )
}

function KindChip({
  pressed,
  onClick,
  label,
  count,
}: {
  pressed: boolean
  onClick: () => void
  label: string
  count: number | undefined
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
      {count !== undefined && <span className="ml-1 opacity-70">{count}</span>}
    </TooltipButton>
  )
}

function IndexOption({
  row,
  id,
  active,
  current,
  onChoose,
}: {
  row: IndexRow
  id: string
  active: boolean
  current: boolean
  onChoose: (visit: BrainVisit) => void
}): React.JSX.Element {
  return (
    <TooltipButton
      id={id}
      role="option"
      aria-selected={active}
      aria-current={current ? 'true' : undefined}
      tooltip={row.visit.label}
      className={clsx('brain-row items-center py-1', active && 'bg-sidebar-hover')}
      onClick={() => onChoose(row.visit)}
    >
      {row.kind ? <KindDot kind={row.kind} /> : <span aria-hidden="true" className="w-2 shrink-0" />}
      <span className={clsx('min-w-0 flex-1', row.kind ? 'truncate' : 'brain-clamp text-sm')}>
        {row.visit.label}
      </span>
      {row.meta && (
        <span className="text-text-tertiary text-sm tabular-nums" aria-label={`${row.meta} memories`}>
          {row.meta}
        </span>
      )}
    </TooltipButton>
  )
}

function IndexState({
  searching,
  empty,
  error,
  loaded,
  retry,
  more,
  onMore,
}: {
  searching: boolean
  empty: boolean
  error: string
  loaded: boolean
  retry: () => void
  more: boolean
  onMore: () => void
}): React.JSX.Element | null {
  if (error)
    return (
      <p role="status" className="p-2 text-sm">
        {error}{' '}
        <Button size="xs" onClick={retry}>
          Retry
        </Button>
      </p>
    )
  if (!loaded) return null
  if (empty)
    return (
      <p className="text-text-tertiary p-2 text-sm">
        {searching
          ? 'No match. Try a first name or a project.'
          : 'No knowledge yet. Right-click a lane and choose Queue for knowledge extraction.'}
      </p>
    )
  return more ? (
    <Button size="xs" className="m-2" onClick={onMore}>
      Show more
    </Button>
  ) : null
}

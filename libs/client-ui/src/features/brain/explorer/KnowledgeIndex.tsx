import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import type { BrainEntityKind } from '@shared/brain'
import { BRAIN_ENTITY_SORTS, type BrainEntitySort } from '@shared/brain-explore'
import { Button, Select, TextInput } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { ENTITY_LABELS, ENTITY_SORT_LABELS } from '../memoryLabels'
import { KindDot } from './KnowledgePrimitives'
import { useIndexRows, type IndexRow } from './useIndexRows'
import type { BrainVisit } from './trail'

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
  const [sort, setSort] = useState<BrainEntitySort>('connected')
  const [active, setActive] = useState(-1)
  const input = useRef<HTMLInputElement>(null)
  const listId = useId()
  useEffect(() => {
    if (searchRequest) input.current?.focus()
  }, [searchRequest])
  const index = useIndexRows(query, kind, sort)
  const { rows } = index
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
        <IndexFilters index={index} kind={kind} onKind={setKind} sort={sort} onSort={setSort} />
      </div>
      <div className="brain-scroll p-1">
        <IndexList
          index={index}
          listId={listId}
          active={active}
          selectedId={selectedId}
          onChoose={choose}
        />
      </div>
    </div>
  )
}

type IndexRows = ReturnType<typeof useIndexRows>

function IndexFilters({
  index,
  kind,
  onKind,
  sort,
  onSort,
}: {
  index: IndexRows
  kind: BrainEntityKind | ''
  onKind: (kind: BrainEntityKind | '') => void
  sort: BrainEntitySort
  onSort: (sort: BrainEntitySort) => void
}): React.JSX.Element {
  return (
    <>
      <div role="group" aria-label="Kinds" className="flex flex-wrap gap-1">
        <KindChip pressed={!kind} onClick={() => onKind('')} label="All" count={index.countAll} />
        {index.kinds.map((k) => (
          <KindChip
            key={k}
            pressed={kind === k}
            onClick={() => onKind(k)}
            label={ENTITY_LABELS[k]}
            count={index.counts[k]}
          />
        ))}
      </div>
      <div className="text-text-tertiary flex flex-wrap items-center justify-between gap-x-2 text-sm">
        <span role="status" className="whitespace-nowrap">
          {index.resultLine}
        </span>
        {index.searching ? (
          <span>By best match</span>
        ) : (
          <Select
            label="Sort"
            value={sort}
            onChange={onSort}
            className="border-0 bg-transparent px-1 py-0 text-sm"
            options={BRAIN_ENTITY_SORTS.map((value) => ({
              value,
              label: ENTITY_SORT_LABELS[value],
            }))}
          />
        )}
      </div>
    </>
  )
}

function IndexList({
  index,
  listId,
  active,
  selectedId,
  onChoose,
}: {
  index: IndexRows
  listId: string
  active: number
  selectedId: string | null
  onChoose: (visit: BrainVisit) => void
}): React.JSX.Element {
  const { entities, memories } = index
  return (
    <>
      <div id={listId} role="listbox" aria-label="People and things">
        {entities.map((row, at) => (
          <IndexOption
            key={row.visit.id}
            row={row}
            id={`${listId}-${at}`}
            active={at === active}
            current={row.visit.id === selectedId}
            onChoose={onChoose}
          />
        ))}
        {memories.length > 0 && (
          <div role="group" aria-label="Memories">
            <SectionLabel>Memories</SectionLabel>
            {memories.map((row, at) => (
              <IndexOption
                key={row.visit.id}
                row={row}
                id={`${listId}-${entities.length + at}`}
                active={entities.length + at === active}
                current={false}
                onChoose={onChoose}
              />
            ))}
          </div>
        )}
      </div>
      <IndexState
        searching={index.searching}
        empty={!index.rows.length}
        error={index.error}
        loaded={index.loaded}
        retry={index.retry}
        more={index.more}
        onMore={index.onMore}
      />
      {index.degradation.map((note) => (
        <p key={note} className="text-text-tertiary p-2 text-sm">
          {note}
        </p>
      ))}
    </>
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
      {row.kind ? (
        <KindDot kind={row.kind} />
      ) : (
        <span aria-hidden="true" className="w-2 shrink-0" />
      )}
      <span className={clsx('min-w-0 flex-1', row.kind ? 'truncate' : 'brain-clamp text-sm')}>
        {row.visit.label}
      </span>
      {row.meta && (
        <span
          className="text-text-tertiary text-sm tabular-nums"
          aria-label={`${row.meta} memories`}
        >
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

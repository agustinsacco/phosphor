import { formatCount } from '@/lib/format'
import { useEffect, useId, useState } from 'react'
import type { BrainFindResult } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button, TextInput } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { useBrain } from '../useBrain'
import { ENTITY_WORDS } from '../memoryLabels'
import type { BrainVisit } from './trail'

/** Search is remote and bounded. Cancelling a timer or selection ignores every older reply. */
export function useBrainFind(query: string) {
  const [data, setData] = useState<BrainFindResult | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const revision = useBrain((s) => s.status?.revision)
  const generation = useBrain((s) => s.status?.generation)
  useEffect(() => {
    let alive = true
    setData(null)
    setError('')
    if (!query.trim()) return
    const timer = setTimeout(() => {
      window.phosphor
        .invoke('brain:find', query.trim(), 12)
        .then((result) => {
          if (alive) setData(result)
        })
        .catch((cause: unknown) => {
          if (alive) setError(ipcErrorText(cause))
        })
    }, 200)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query, revision, generation, attempt])
  return { data, error, retry: () => setAttempt((n) => n + 1) }
}

interface SearchProps {
  onSelect: (visit: BrainVisit) => void
  entitiesOnly?: boolean
  exclude?: string
  autoFocus?: boolean
}
/** A search field with its own results: the other end of a route or a merge. */
export function BrainSearch({
  onSelect,
  entitiesOnly = false,
  exclude,
  autoFocus = false,
}: SearchProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const resource = useBrainFind(query)
  const listId = useId()
  const visits = searchVisits(resource.data, entitiesOnly, exclude)
  const change = (value: string): void => {
    setQuery(value)
    setActive(0)
  }
  const choose = (visit: BrainVisit): void => {
    onSelect(visit)
    change('')
  }
  const key = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      change('')
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((i) =>
        Math.max(0, Math.min(visits.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1))),
      )
    }
    if (event.key === 'Enter' && visits[active]) {
      event.preventDefault()
      choose(visits[active]!)
    }
  }
  const label = entitiesOnly ? 'Find a person or thing' : 'Find a person, project or memory'
  return (
    <section aria-label={entitiesOnly ? 'Choose entity' : 'Find knowledge'} className="space-y-2">
      <TextInput
        role="combobox"
        autoFocus={autoFocus}
        aria-label={label}
        placeholder={label}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={!!query}
        aria-activedescendant={visits[active] ? `${listId}-${active}` : undefined}
        value={query}
        className="w-full"
        onChange={(event) => change(event.target.value)}
        onKeyDown={key}
      />
      {query && (
        <SearchResults
          resource={resource}
          listId={listId}
          visits={visits}
          active={active}
          query={query}
          choose={choose}
        />
      )}
    </section>
  )
}
function searchVisits(
  data: BrainFindResult | null,
  entitiesOnly: boolean,
  exclude?: string,
): BrainVisit[] {
  return [
    ...(data?.entities ?? [])
      .filter((e) => e.id !== exclude)
      .map((e): BrainVisit => ({ kind: 'entity', id: e.id, label: e.label })),
    ...(!entitiesOnly
      ? (data?.memories ?? []).map((m): BrainVisit => ({
          kind: 'memory',
          id: m.id,
          label: m.summary,
        }))
      : []),
  ]
}
function SearchResults({
  resource,
  listId,
  visits,
  active,
  query,
  choose,
}: {
  resource: ReturnType<typeof useBrainFind>
  listId: string
  visits: BrainVisit[]
  active: number
  query: string
  choose: (visit: BrainVisit) => void
}): React.JSX.Element {
  const { data, error, retry } = resource
  return (
    <div
      id={listId}
      role="listbox"
      aria-label="Search results"
      className="border-border space-y-1 rounded-lg border p-2"
    >
      {error ? (
        <p role="status">
          {error}{' '}
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        </p>
      ) : !data ? (
        <p role="status">Finding…</p>
      ) : (
        <>
          {!visits.length && <p role="status">No match. Try a first name or a project.</p>}
          {(['entity', 'memory'] as const).map((kind) => {
            const group = visits.filter((v) => v.kind === kind)
            return (
              group.length > 0 && (
                <div
                  key={kind}
                  role="group"
                  aria-label={kind === 'entity' ? 'People and things' : 'Memories'}
                >
                  <h3 className="text-text-tertiary font-mono text-xs uppercase tracking-wider">
                    {kind === 'entity' ? 'People and things' : 'Memories'}
                  </h3>
                  {group.map((visit) => (
                    <SearchOption
                      key={visit.id}
                      visit={visit}
                      index={visits.indexOf(visit)}
                      listId={listId}
                      active={active}
                      query={query}
                      data={data}
                      choose={choose}
                    />
                  ))}
                </div>
              )
            )
          })}
          {data.degradation.map((note) => (
            <p key={note} role="status" className="text-text-tertiary text-sm">
              {note}
            </p>
          ))}
        </>
      )}
    </div>
  )
}
function SearchOption({
  visit,
  index,
  listId,
  active,
  query,
  data,
  choose,
}: {
  visit: BrainVisit
  index: number
  listId: string
  active: number
  query: string
  data: BrainFindResult
  choose: (visit: BrainVisit) => void
}): React.JSX.Element {
  const entity = data.entities.find((e) => e.id === visit.id)
  const memory = data.memories.find((m) => m.id === visit.id)
  const alias = entity?.aliases.find((a) =>
    a.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  )
  return (
    <TooltipButton
      id={`${listId}-${index}`}
      role="option"
      aria-selected={active === index}
      className={`block w-full rounded p-2 text-left ${active === index ? 'bg-sidebar-active' : 'hover:bg-sidebar-hover'}`}
      onClick={() => choose(visit)}
    >
      <span className="block">{visit.label}</span>
      <span className="text-text-tertiary text-sm">
        {entity
          ? `${ENTITY_WORDS[entity.kind]} · ${formatCount(entity.memories, 'memory', 'memories')}${alias ? ` · matched alias: ${alias}` : ''}`
          : `${memory?.type} · ${memory?.state}`}
      </span>
    </TooltipButton>
  )
}

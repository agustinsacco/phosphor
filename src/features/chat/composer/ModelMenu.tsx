import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import clsx from 'clsx'
import type { ModelCost } from '@shared/rpc'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { CheckIcon, StarIcon } from '@/components/icons'
import { formatTokens } from '@/lib/format'
import { availabilityKey, unavailableModels } from '@/lib/modelAvailability'
import {
  groupModels,
  highlightRanges,
  modelKey,
  searchModels,
  stripRegionSuffix,
  type GroupMode,
  type ModelGroup,
  type ModelSearchResult,
} from '@/lib/modelSearch'
import { useModelPicksStore } from '@/stores/modelPicks'

/** Minimal shape both pickers share (session RPC models / catalogue models). */
export interface ModelMenuEntry {
  id: string
  name: string
  provider: string
  /** Metadata is optional — the models.json fallback carries none of it. */
  reasoning?: boolean
  contextWindow?: number
  cost?: ModelCost
  input?: string[]
}

/**
 * Searchable model list shared by the session composer picker and the home
 * screen picker.
 *
 * The catalogue is a list of ROUTES, not of models. "Claude Opus 5" can be
 * five rows at once — pi's native `anthropic` provider, the Claude Code CLI
 * provider, and three Bedrock inference profiles — and the old flat list gave
 * the user five visually identical rows and a subsequence matcher that could
 * not tell them apart. Four things fix that here:
 *
 *   - **Lexical search** (`lib/modelSearch`): terms AND together in any order,
 *     separators are noise, and providers answer to the names people actually
 *     type (`aws`, `claude code`). `provider:`/`id:`/`name:`/`is:` qualifiers
 *     and `-negation` are there for when a query needs to be exact.
 *   - **Family grouping**: every route to one model sits under one header, so
 *     the question becomes "which Opus 5?" instead of "which of these five
 *     identical rows?". Toggleable to provider grouping, which is the better
 *     read of an unsearched catalogue.
 *   - **Identity on every row**: provider and id always render. Two providers
 *     serving the same display name is the normal case, not an edge one.
 *   - **Stars and recents**, so the models someone actually rotates between
 *     are reachable without typing at all.
 *
 * Models the catalogue itself shows to be uninvocable (a bare Bedrock
 * foundation id that only exists as inference profiles — see
 * `lib/modelAvailability`) render dimmed and unselectable, with the working
 * variants named in the hint. They stay visible rather than hidden so that
 * searching "fable" still explains where Fable went, instead of silently
 * omitting the row the user typed.
 */
export function ModelMenu({
  models,
  isCurrent,
  onPick,
  onClose,
  emptyText,
  loading = false,
  notice,
  className,
}: {
  models: ModelMenuEntry[]
  isCurrent: (model: ModelMenuEntry) => boolean
  onPick: (model: ModelMenuEntry) => void
  onClose: () => void
  emptyText: string
  /**
   * The list is still being fetched. Without this an empty `models` reads as
   * "none configured", and the menu answers a question it has not asked yet.
   */
  loading?: boolean
  /** Shown above a NON-empty list that is known to be incomplete. */
  notice?: string
  className?: string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [providerFilter, setProviderFilter] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const starred = useModelPicksStore((s) => s.starred)
  const recent = useModelPicksStore((s) => s.recent)
  const groupMode = useModelPicksStore((s) => s.groupMode)
  const setGroupMode = useModelPicksStore((s) => s.setGroupMode)
  const toggleStarred = useModelPicksStore((s) => s.toggleStarred)
  const recordUse = useModelPicksStore((s) => s.recordUse)

  useEffect(() => {
    inputRef.current?.focus()
    void useModelPicksStore.getState().hydrate()
  }, [])

  const unavailable = useMemo(() => unavailableModels(models), [models])
  const starredSet = useMemo(() => new Set(starred), [starred])
  const recentSet = useMemo(() => new Set(recent), [recent])

  /** Providers present in the catalogue, with counts, for the filter chips. */
  const providers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const model of models) counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [models])

  const results = useMemo(() => {
    const ranked = searchModels(query, models, {
      starred: starredSet,
      recent: recentSet,
      unavailable: new Set(unavailable.keys()),
    })
    if (providerFilter.length === 0) return ranked
    const allowed = new Set(providerFilter)
    return ranked.filter((r) => allowed.has(r.model.provider))
  }, [query, models, starredSet, recentSet, unavailable, providerFilter])

  const searching = query.trim().length > 0
  const byKey = useMemo(() => new Map(results.map((r) => [r.key, r])), [results])

  /**
   * The rendered list, flattened.
   *
   * Headers and rows share one array because ↑/↓ has to walk rows in the exact
   * order they appear — deriving the order twice (once to render, once to
   * navigate) is how a highlight ends up on a different row than the one Enter
   * picks.
   */
  const rows = useMemo(
    () =>
      buildRows({
        groups: groupModels(results, groupMode, searching),
        groupMode,
        // Shortcut sections are an IDLE affordance. During a search they would
        // print the same model twice — once as a shortcut, once in its family —
        // for no gain, since the query already found it.
        starred: searching ? [] : starred.map((k) => byKey.get(k)).filter(isResult),
        recent: searching
          ? []
          : recent
              .filter((k) => !starredSet.has(k))
              .map((k) => byKey.get(k))
              .filter(isResult),
      }),
    [results, groupMode, searching, starred, recent, starredSet, byKey],
  )

  /** Indices of rows Enter/↑/↓ may land on: model rows that are not disabled. */
  const selectable = useMemo(
    () =>
      rows
        .map((row, index) =>
          row.kind === 'model' && !unavailable.has(availabilityKey(row.result.model)) ? index : -1,
        )
        .filter((index) => index >= 0),
    [rows, unavailable],
  )

  // Keep the highlight on a selectable row as the query narrows the list.
  useEffect(() => {
    if (selectable.length === 0) return
    if (!selectable.includes(activeIndex)) setActiveIndex(selectable[0] as number)
  }, [selectable, activeIndex])

  const activeModel = (): ModelMenuEntry | null => {
    const row = rows[activeIndex]
    return row?.kind === 'model' ? row.result.model : null
  }

  const pick = (model: ModelMenuEntry): void => {
    recordUse(modelKey(model))
    onPick(model)
  }

  /** Step through `selectable` only, wrapping at both ends. */
  const step = (delta: number): void => {
    if (selectable.length === 0) return
    setActiveIndex((current) => {
      const at = selectable.indexOf(current)
      // Highlight is on a disabled row (or nowhere): enter the ring at the end
      // that matches the direction of travel.
      if (at === -1) return selectable[delta > 0 ? 0 : selectable.length - 1] as number
      const next = (at + delta + selectable.length) % selectable.length
      return selectable[next] as number
    })
  }

  const handleKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      step(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      step(-1)
    } else if (event.key === 'Home' && selectable.length > 0) {
      event.preventDefault()
      setActiveIndex(selectable[0] as number)
    } else if (event.key === 'End' && selectable.length > 0) {
      event.preventDefault()
      setActiveIndex(selectable[selectable.length - 1] as number)
    } else if (event.key === 'PageDown') {
      event.preventDefault()
      step(PAGE_STEP)
    } else if (event.key === 'PageUp') {
      event.preventDefault()
      step(-PAGE_STEP)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const model = activeModel()
      if (model && !unavailable.has(availabilityKey(model))) pick(model)
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      // Star the highlighted row without leaving the keyboard. Deliberately not
      // Enter-adjacent: starring must never be one slip away from switching
      // the model mid-session.
      event.preventDefault()
      const model = activeModel()
      if (model) toggleStarred(modelKey(model))
    } else if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    }
  }

  const toggleProvider = (provider: string): void => {
    setActiveIndex(0)
    setProviderFilter((current) =>
      current.includes(provider) ? current.filter((p) => p !== provider) : [...current, provider],
    )
  }

  // Not anchored to the trigger: an absolutely-positioned popup wide enough
  // to hold model names could sit partly outside the viewport, and focusing
  // its search input then made the browser auto-scroll the nearest
  // scrollable ancestor to reveal it — visibly shifting the whole app. A
  // fixed, centered, body-portaled overlay can never do that, and it always
  // paints above the rest of the UI regardless of stacking contexts upstream.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[2px]">
      <PopupMenu onClose={onClose} className={className}>
        <div className="border-border border-b">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            disabled={loading}
            placeholder={
              loading ? 'Loading models…' : 'Search models — try “opus bedrock” or “provider:aws”'
            }
            data-testid="model-search"
            // composer-field: opt out of the global accent focus outline — the
            // popup frame already signals where focus lives.
            className="composer-field text-text placeholder:text-text-tertiary w-full bg-transparent px-3 py-2 text-lg outline-none"
          />
        </div>

        {providers.length > 1 && (
          <div className="border-border flex max-h-20 flex-wrap gap-1 overflow-y-auto border-b px-2 py-1.5">
            <FilterChip
              label="All"
              active={providerFilter.length === 0}
              onClick={() => {
                setActiveIndex(0)
                setProviderFilter([])
              }}
            />
            {providers.map(([provider, count]) => (
              <FilterChip
                key={provider}
                label={provider}
                count={count}
                active={providerFilter.includes(provider)}
                onClick={() => toggleProvider(provider)}
              />
            ))}
          </div>
        )}

        <div className="max-h-80 overflow-y-auto py-1.5" data-testid="model-list">
          {rows.map((row, index) =>
            row.kind === 'header' ? (
              <div
                key={`h:${row.id}`}
                className="text-text-tertiary flex items-baseline gap-1.5 px-3 pb-0.5 pt-2 font-mono text-xs uppercase tracking-wide"
              >
                <span className="truncate">{row.label}</span>
                {row.count > 1 && <span className="opacity-60">{row.count}</span>}
              </div>
            ) : (
              <ModelRow
                key={`${row.section}:${row.result.key}`}
                result={row.result}
                query={query}
                /* Inside a family group the name is the header, so the provider
                 is what tells the routes apart — lead with it. */
                lead={row.lead}
                familyLabel={row.familyLabel}
                active={index === activeIndex}
                blocked={unavailable.get(availabilityKey(row.result.model))}
                current={isCurrent(row.result.model)}
                starred={starredSet.has(row.result.key)}
                onHover={() => setActiveIndex(index)}
                onClick={() => pick(row.result.model)}
                onToggleStar={() => toggleStarred(row.result.key)}
              />
            ),
          )}

          {loading && models.length === 0 && <ModelRowSkeletons />}
          {!loading && models.length === 0 && (
            <div className="text-text-tertiary px-3 py-2 text-base">{emptyText}</div>
          )}
          {/* A short list is indistinguishable from a complete one, so when we
              know it is short, say why here rather than only on the chip. */}
          {notice && models.length > 0 && (
            <div className="text-warning px-3 py-2 text-sm" data-testid="model-menu-notice">
              {notice}
            </div>
          )}
          {models.length > 0 && results.length === 0 && (
            <div className="text-text-tertiary px-3 py-2 text-base">
              {searching
                ? `No models match “${query}”.`
                : 'No models match the selected providers.'}
            </div>
          )}
        </div>

        <div className="border-border text-text-tertiary flex items-center gap-2 border-t px-2.5 py-1.5 text-xs">
          <span className="tabular-nums">
            {loading && models.length === 0 ? 'Loading…' : `${results.length} of ${models.length}`}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <span className="hidden sm:inline">Group</span>
            <GroupChip
              label="Model"
              active={groupMode === 'family'}
              onClick={() => setGroupMode('family')}
            />
            <GroupChip
              label="Provider"
              active={groupMode === 'provider'}
              onClick={() => setGroupMode('provider')}
            />
          </span>
        </div>
      </PopupMenu>
    </div>,
    document.body,
  )
}

/** ↑/↓ steps per PageUp/PageDown — roughly one visible screen of rows. */
const PAGE_STEP = 8

// ------------------------------------------------------------------ row model

type Section = 'starred' | 'recent' | 'main'

type Row =
  | { kind: 'header'; id: string; label: string; count: number }
  | {
      kind: 'model'
      section: Section
      result: ModelSearchResult<ModelMenuEntry>
      /** `provider` inside a family group, `name` everywhere else. */
      lead: 'name' | 'provider'
      /** The family header's text, so a row can render only what it adds to it. */
      familyLabel?: string
    }

function isResult(
  value: ModelSearchResult<ModelMenuEntry> | undefined,
): value is ModelSearchResult<ModelMenuEntry> {
  return value !== undefined
}

/**
 * Flatten sections and groups into the exact sequence rendered.
 *
 * A family header only appears when the family has more than one route:
 * a header over a single row would double the height of most of the list to
 * restate the row's own name.
 */
function buildRows({
  groups,
  groupMode,
  starred,
  recent,
}: {
  groups: ModelGroup<ModelMenuEntry>[]
  groupMode: GroupMode
  starred: ModelSearchResult<ModelMenuEntry>[]
  recent: ModelSearchResult<ModelMenuEntry>[]
}): Row[] {
  const rows: Row[] = []

  const shortcut = (section: Section, label: string, items: typeof starred): void => {
    if (items.length === 0) return
    rows.push({ kind: 'header', id: section, label, count: items.length })
    for (const result of items) rows.push({ kind: 'model', section, result, lead: 'name' })
  }
  shortcut('starred', 'Starred', starred)
  shortcut('recent', 'Recent', recent)

  for (const group of groups) {
    const family = groupMode === 'family'
    // Family: a header earns its line only when it covers more than one route.
    // Provider: the header IS the answer to "from whom", so it stays unless
    // there is only one provider and it would be restating the obvious.
    const headed = family ? group.items.length > 1 : groups.length > 1
    if (headed) {
      rows.push({ kind: 'header', id: group.key, label: group.label, count: group.items.length })
    }
    for (const result of group.items) {
      rows.push({
        kind: 'model',
        section: 'main',
        result,
        lead: family && headed ? 'provider' : 'name',
        ...(family && headed ? { familyLabel: group.label } : {}),
      })
    }
  }
  return rows
}

// ------------------------------------------------------------------ rendering

function ModelRow({
  result,
  query,
  lead,
  familyLabel,
  active,
  blocked,
  current,
  starred,
  onHover,
  onClick,
  onToggleStar,
}: {
  result: ModelSearchResult<ModelMenuEntry>
  query: string
  lead: 'name' | 'provider'
  familyLabel?: string
  active: boolean
  blocked: { detail: string } | undefined
  current: boolean
  starred: boolean
  onHover: () => void
  onClick: () => void
  onToggleStar: () => void
}): React.JSX.Element {
  const model = result.model
  const name = model.name || model.id
  // Under a family header the name is already on screen; what distinguishes
  // this row is the route, plus whatever the name adds beyond the family
  // ("(US)", "(EU)") — which is exactly the region that decides latency.
  const variant = familyLabel ? name.slice(stripRegionSuffix(name).length).trim() : ''
  const primary = lead === 'provider' ? model.provider : name
  const facts = modelFacts(model)

  return (
    <MenuRow
      active={active}
      disabled={blocked !== undefined}
      onHover={onHover}
      onClick={onClick}
      testId="model-row"
      title={blocked ? `${model.id} — ${blocked.detail}` : `${model.provider}/${model.id}`}
      trailing={
        <button
          // A row is a <button>; this must not be nested inside it (see MenuRow).
          onClick={(event) => {
            event.stopPropagation()
            onToggleStar()
          }}
          aria-label={starred ? `Unstar ${name}` : `Star ${name}`}
          aria-pressed={starred}
          title={starred ? 'Unstar (⌘D)' : 'Star (⌘D)'}
          // Never emit opacity-0 and opacity-100 together: Tailwind resolves a
          // conflict by stylesheet order, not by the order of the class string,
          // so which one wins would be an accident.
          className={clsx(
            'hover:bg-bg-secondary cursor-pointer rounded p-1 transition-colors',
            starred
              ? 'text-accent'
              : clsx(
                  'text-text-tertiary hover:text-text',
                  // An unstarred control is quiet until the row is reachable —
                  // hovered, highlighted, or tabbed to.
                  active
                    ? 'opacity-100'
                    : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
                ),
          )}
        >
          <StarIcon filled={starred} />
        </button>
      }
    >
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className={clsx('truncate', lead === 'provider' && 'font-mono text-base')}>
            <Highlighted text={primary} query={query} />
          </span>
          {variant && <span className="text-text-secondary shrink-0 text-sm">{variant}</span>}
          {current && <CheckIcon className="text-text shrink-0" />}
        </span>

        <span className="text-text-tertiary flex min-w-0 items-baseline gap-1.5 text-sm leading-snug">
          {lead === 'name' && (
            <span className="shrink-0 font-mono">
              <Highlighted text={model.provider} query={query} />
            </span>
          )}
          <span className="truncate font-mono opacity-80">
            <Highlighted text={model.id} query={query} />
          </span>
          {facts && <span className="ml-auto shrink-0 tabular-nums opacity-80">{facts}</span>}
        </span>

        {/* Wraps rather than truncates: a clipped "pick a region-pr…" tells
            the user nothing, and this row is the only place the reason
            appears. */}
        {blocked && (
          <span className="text-text-tertiary block text-sm leading-snug">{blocked.detail}</span>
        )}
      </span>
    </MenuRow>
  )
}

/**
 * The one-line comparison summary: context window, then input price.
 *
 * Only what the catalogue actually supplied — the models.json fallback has no
 * pricing, and an invented number here would be read as authoritative.
 */
function modelFacts(model: ModelMenuEntry): string {
  const parts: string[] = []
  if (typeof model.contextWindow === 'number' && model.contextWindow > 0) {
    parts.push(`${formatTokens(model.contextWindow)} ctx`)
  }
  if (model.input?.includes('image')) parts.push('vision')
  if (model.cost && model.cost.input > 0) parts.push(`$${trimZeros(model.cost.input)}/M`)
  return parts.join(' · ')
}

function trimZeros(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** Emphasise the parts of `text` the query matched. */
function Highlighted({ text, query }: { text: string; query: string }): React.JSX.Element {
  const ranges = useMemo(() => highlightRanges(text, query), [text, query])
  if (ranges.length === 0) return <>{text}</>

  const parts: React.ReactNode[] = []
  let at = 0
  for (const [index, range] of ranges.entries()) {
    if (range.start > at) parts.push(text.slice(at, range.start))
    parts.push(
      <mark key={index} className="text-accent bg-transparent font-semibold">
        {text.slice(range.start, range.end)}
      </mark>,
    )
    at = range.end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string
  count?: number
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'shrink-0 cursor-pointer rounded-md px-2 py-0.5 font-mono text-xs transition-colors',
        active
          ? 'bg-bg-secondary text-text'
          : 'text-text-tertiary hover:bg-bg-secondary hover:text-text',
      )}
    >
      {label}
      {count !== undefined && <span className="ml-1 opacity-60 tabular-nums">{count}</span>}
    </button>
  )
}

function GroupChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'cursor-pointer rounded px-1.5 py-0.5 transition-colors',
        active ? 'bg-bg-secondary text-text' : 'hover:text-text',
      )}
    >
      {label}
    </button>
  )
}

/** Placeholder rows while the catalogue is still being fetched. */
function ModelRowSkeletons(): React.JSX.Element {
  return (
    <div className="space-y-2 px-3 py-2" data-testid="model-list-loading" aria-busy="true">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <div className="bg-bg-secondary h-3.5 flex-1 animate-pulse rounded" />
          <div className="bg-bg-secondary h-3.5 w-16 animate-pulse rounded" />
        </div>
      ))}
    </div>
  )
}

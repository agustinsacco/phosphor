import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ModelCost } from '@shared/rpc'
import { PopupMenu } from '@/components/PopupMenu'
import { availabilityKey, unavailableModels } from '@/lib/modelAvailability'
import { groupModels, modelKey, searchModels } from '@/lib/modelSearch'
import { buildRows, FilterChip, GroupChip, isResult, ModelRow } from './ModelMenuRows'
import { ModelMenuStatus } from './ModelMenuStatus'
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
 * variants named in the hint, as do models a caller's `unavailable` names
 * (a Host's signed-out provider). They stay visible rather than hidden so that
 * searching "fable" still explains where Fable went.
 */
/** Starred, recent and grouping picks, hydrated once per open menu. */
function useModelPicks() {
  useEffect(() => {
    useModelPicksStore
      .getState()
      .hydrate()
      .catch(() => undefined)
  }, [])
  return {
    starred: useModelPicksStore((s) => s.starred),
    recent: useModelPicksStore((s) => s.recent),
    groupMode: useModelPicksStore((s) => s.groupMode),
    setGroupMode: useModelPicksStore((s) => s.setGroupMode),
    toggleStarred: useModelPicksStore((s) => s.toggleStarred),
    recordUse: useModelPicksStore((s) => s.recordUse),
  }
}

export function ModelMenu({
  models,
  isCurrent,
  onPick,
  onClose,
  emptyText,
  loading = false,
  error,
  onRetry,
  notice,
  unavailable: blocked,
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
  error?: string | null | undefined
  onRetry?: (() => void) | undefined
  /** Shown above a NON-empty list that is known to be incomplete. */
  notice?: string
  /** Replaces the catalogue's own rule, keyed `provider/id`, when the caller knows more. */
  unavailable?: ReadonlyMap<string, { detail: string }>
  className?: string
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const [providerFilter, setProviderFilter] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const cold = loading && models.length === 0

  const { starred, recent, groupMode, setGroupMode, toggleStarred, recordUse } = useModelPicks()
  useEffect(() => {
    if (!cold) inputRef.current?.focus()
  }, [cold])

  const unavailable = useMemo(() => blocked ?? unavailableModels(models), [blocked, models])
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
   * The rendered list, flattened. Headers and rows share one array because ↑/↓
   * has to walk rows in the exact order they appear: deriving the order twice
   * is how a highlight ends up on a different row than the one Enter picks.
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
      <PopupMenu withinOverlay onClose={onClose} className={className}>
        <div className="border-border border-b">
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={handleKeyDown}
            disabled={cold}
            placeholder={
              cold ? 'Loading models…' : 'Search models — try “opus bedrock” or “provider:aws”'
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
          <ModelMenuStatus loading={loading} cold={cold} error={error} onRetry={onRetry} />
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

          {!cold && !error && models.length === 0 && (
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
          <span className="tabular-nums">{!cold && `${results.length} of ${models.length}`}</span>
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

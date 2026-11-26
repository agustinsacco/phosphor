import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { MenuRow } from '@/components/PopupMenu'
import { Highlighted } from '@/components/search/Highlighted'
import { CheckIcon, StarIcon } from '@/components/icons'
import { formatTokens } from '@/lib/format'
import {
  stripRegionSuffix,
  type GroupMode,
  type ModelGroup,
  type ModelSearchResult,
} from '@/lib/modelSearch'
import type { ModelMenuEntry } from './ModelMenu'

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

export function isResult(
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
export function buildRows({
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

export function ModelRow({
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
      trailing={<StarModelButton {...{ name, starred, active, onToggleStar }} />}
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

/** Star is a separate button; it must not also select the row. */
function StarModelButton({
  name,
  starred,
  active,
  onToggleStar,
}: {
  name: string
  starred: boolean
  active: boolean
  onToggleStar: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={(event) => {
        event.stopPropagation()
        onToggleStar()
      }}
      aria-label={starred ? `Unstar ${name}` : `Star ${name}`}
      aria-pressed={starred}
      title={starred ? 'Unstar (⌘D)' : 'Star (⌘D)'}
      className={clsx(
        'hover:bg-bg-secondary cursor-pointer rounded p-1 transition-colors',
        starred
          ? 'text-accent'
          : clsx(
              'text-text-tertiary hover:text-text',
              active
                ? 'opacity-100'
                : 'opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100',
            ),
      )}
    >
      <StarIcon filled={starred} />
    </TooltipButton>
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

export function FilterChip({
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
    <TooltipButton
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
    </TooltipButton>
  )
}

export function GroupChip({
  label,
  active,
  onClick,
}: {
  label: string
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      aria-pressed={active}
      className={clsx(
        'cursor-pointer rounded px-1.5 py-0.5 transition-colors',
        active ? 'bg-bg-secondary text-text' : 'hover:text-text',
      )}
    >
      {label}
    </TooltipButton>
  )
}

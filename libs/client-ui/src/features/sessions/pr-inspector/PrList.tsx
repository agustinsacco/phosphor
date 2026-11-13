import { useRef } from 'react'
import clsx from 'clsx'
import { prLabel } from '@shared/github-pr-refs'
import type { GhPrKey, GhPrRef } from '@shared/models'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import type { LanePr, LanePrs } from '../lanePrs'
import { PrGlyph, stateGlyph, TONE_TEXT, verdictGlyph } from './PrIcons'

/** `#57` in the lane's own repository, `other-repo#12` elsewhere. */
export function lanePrLabel(item: LanePr, home: LanePrs['home']): string {
  return item.ref ? prLabel(item.ref, home?.repo) : `#${item.number}`
}

const GROUPS = [
  ['owned', 'This lane'],
  ['reviewing', 'Reviewing'],
  ['mentioned', 'Mentioned'],
] as const

/**
 * The inspector's PR list: one tab stop, arrow keys move the selection.
 * Suggestions carry a `+` that tracks them in one click; it is a pointer
 * shortcut, and the selected suggestion's header has the same action for the
 * keyboard (an option cannot hold a button).
 */
export function PrList({
  prs,
  selected,
  onSelect,
  onTrack,
  onTrackOther,
}: {
  prs: LanePrs
  selected: GhPrKey | undefined
  onSelect: (key: GhPrKey) => void
  onTrack: (ref: GhPrRef) => void
  onTrackOther: () => void
}): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const order = [...prs.owned, ...prs.reviewing, ...prs.mentioned]
  const move = (event: React.KeyboardEvent): void => {
    const index = order.findIndex((item) => item.key === selected)
    const next =
      event.key === 'ArrowDown' || event.key === 'ArrowRight'
        ? Math.min(order.length - 1, index + 1)
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
          ? Math.max(0, index - 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? order.length - 1
              : null
    if (next === null || !order[next]) return
    event.preventDefault()
    onSelect(order[next].key)
    list.current
      ?.querySelector<HTMLElement>(`[data-pr-key="${CSS.escape(order[next].key)}"]`)
      ?.focus()
  }
  return (
    <div className="pr-inspector-list border-border flex min-h-0 flex-col overflow-y-auto border-r p-1.5">
      <div
        ref={list}
        role="listbox"
        aria-label="Pull requests"
        aria-orientation="vertical"
        onKeyDown={move}
        className="contents"
      >
        {GROUPS.map(([group, label]) =>
          prs[group].length ? (
            <div key={group} role="group" aria-label={label} className="contents">
              <div
                data-pr-group-label
                aria-hidden="true"
                className="text-text-tertiary px-2 pb-1 pt-2 font-mono text-xs uppercase tracking-[0.07em] first:pt-0.5"
              >
                {label}
              </div>
              {prs[group].map((item) => (
                <PrListItem
                  key={item.key}
                  item={item}
                  label={lanePrLabel(item, prs.home)}
                  selected={item.key === selected}
                  onSelect={() => onSelect(item.key)}
                  onTrack={group === 'owned' || !item.ref ? undefined : () => onTrack(item.ref!)}
                />
              ))}
            </div>
          ) : null,
        )}
      </div>
      <TooltipButton
        type="button"
        data-pr-track
        onClick={onTrackOther}
        className="text-text-secondary hover:text-accent focus-visible:outline-accent mt-1 rounded-md px-2 py-1.5 text-left text-base hover:underline focus-visible:outline focus-visible:outline-2"
      >
        Track a PR…
      </TooltipButton>
    </div>
  )
}

function PrListItem({
  item,
  label,
  selected,
  onSelect,
  onTrack,
}: {
  item: LanePr
  label: string
  selected: boolean
  onSelect: () => void
  onTrack?: () => void
}): React.JSX.Element {
  const tone = TONE_TEXT[item.verdict.tone]
  return (
    <div
      role="option"
      aria-selected={selected}
      tabIndex={selected ? 0 : -1}
      data-pr-key={item.key}
      data-popup-autofocus={selected || undefined}
      data-testid="pr-inspector-item"
      onClick={onSelect}
      className={clsx(
        'focus-visible:outline-accent mb-0.5 cursor-pointer rounded-md px-2 py-1.5 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2',
        selected ? 'bg-sidebar-active' : 'hover:bg-bg-secondary',
      )}
    >
      <div className="flex items-center gap-1.5">
        <PrGlyph glyph={stateGlyph(item.pr)} size={13} className={tone} />
        <span className="text-text-secondary min-w-0 truncate font-mono text-base">{label}</span>
        <span className="flex-1" />
        {onTrack ? (
          <span
            aria-hidden="true"
            data-testid="pr-inspector-track"
            data-tooltip={`Track ${label} in this lane`}
            onClick={(event) => {
              event.stopPropagation()
              onTrack()
            }}
            className="text-text-tertiary hover:text-accent hover:bg-chip -my-0.5 grid size-5 place-items-center rounded"
          >
            <PrGlyph glyph="plus" size={12} />
          </span>
        ) : (
          <PrGlyph glyph={verdictGlyph(item.verdict)} size={13} className={tone} />
        )}
      </div>
      <div
        className="text-text-secondary pr-clamp-2 mt-0.5 text-sm leading-snug"
        {...tooltipProps(item.pr?.title)}
      >
        {item.pr?.title ?? 'Reading…'}
      </div>
      <div data-pr-item-headline className={clsx('mt-0.5 truncate text-sm', tone)}>
        {item.verdict.headline}
      </div>
    </div>
  )
}

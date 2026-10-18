import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useRef } from 'react'
import { CloseIcon, SearchIcon } from '@/components/icons'

/**
 * The search field under a workspace header.
 *
 * It sits in the group's own block rather than floating over the list, so
 * opening it pushes the lanes down instead of covering the first two.
 *
 * Typing does not filter — Enter does. A per-keystroke filter makes the list
 * jump under a reader who is still deciding what to type, and on this list the
 * rows are the navigation. The `x` and Escape both retract the filter *and*
 * close the bar: a closed bar hiding lanes is an unexplained empty sidebar.
 */
export function LaneSearchBar({
  value,
  applied,
  matchCount,
  total,
  onChange,
  onCommit,
  onClear,
}: {
  /** Draft text, which may differ from what is currently filtering. */
  value: string
  /** A filter is in force, so the count and the clear control are earned. */
  applied: boolean
  matchCount: number
  total: number
  onChange: (value: string) => void
  onCommit: () => void
  onClear: () => void
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)
  // Focus on mount rather than with `autoFocus`: the bar mounts on a click on
  // the header's search button, and the caret has to land here, not stay there.
  useEffect(() => inputRef.current?.focus(), [])

  return (
    <div className="px-2 pb-1 pt-0.5">
      <div className="border-border focus-within:border-accent flex items-center gap-1 rounded-md border px-1.5 py-1 transition-colors">
        <SearchIcon size={11} className="text-text-tertiary shrink-0" />
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onCommit()
            if (e.key === 'Escape') {
              // The sidebar also clears a lane selection on Escape, and the
              // window has its own handlers. This one is about the bar only.
              e.stopPropagation()
              onClear()
            }
          }}
          placeholder="Name, branch or PR"
          aria-label="Search lanes"
          data-testid="lane-search-input"
          // `lane-search-field` opts out of the global keyboard focus ring —
          // the bordered row around it is the focus signal. See index.css.
          className="lane-search-field text-text placeholder:text-text-tertiary min-w-0 flex-1 bg-transparent text-xs leading-4 outline-none"
          data-tooltip="Search lanes"
        />
        {applied && (
          <>
            <span className="text-text-tertiary shrink-0 text-2xs tabular-nums">
              {matchCount}/{total}
            </span>
            <TooltipButton
              onClick={onClear}
              title="Clear search"
              aria-label="Clear search"
              data-testid="lane-search-clear"
              className="text-text-tertiary hover:text-text hover:bg-sidebar-hover flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors active:scale-90"
            >
              <CloseIcon size={10} strokeWidth={2.5} />
            </TooltipButton>
          </>
        )}
      </div>
    </div>
  )
}

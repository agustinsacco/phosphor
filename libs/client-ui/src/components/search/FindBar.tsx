import { TooltipButton } from '@/components/Tooltip'
import { useId, useLayoutEffect } from 'react'
import clsx from 'clsx'
import type { CompiledQuery } from '@shared/text-search'
import { ChevronDownIcon, CloseIcon, SearchIcon } from '@/components/icons'
import { formatShortcut } from '@/lib/shortcuts'
import { optionForKey, SearchOptionToggles } from './SearchOptionToggles'
import type { FindState } from './useFind'

/** Why a surface cannot search what it shows, and what makes it searchable. */
export interface FindUnavailable {
  reason: string
  /** The button's label: "Switch to Code". */
  action: string
  onAction: () => void
}

/**
 * "3 of 12", "No results", the reason a regex will not compile, or why this
 * view cannot be searched. A live region, rendered even while empty, so the
 * first count after typing is announced.
 */
function FindStatus({
  id,
  compiled,
  total,
  active,
  capped,
  unavailable,
}: {
  id: string
  compiled: CompiledQuery
  total: number
  active: number
  capped: boolean
  unavailable?: FindUnavailable
}): React.JSX.Element {
  let content: React.ReactNode = null
  let tone = 'text-text-tertiary'
  if (unavailable) {
    // The visible part is the action button beside this.
    content = <span className="sr-only">{unavailable.reason}</span>
  } else if (compiled.status === 'invalid') {
    tone = 'text-danger'
    content = (
      <>
        Invalid regex<span className="sr-only">: {compiled.error}</span>
      </>
    )
  } else if (compiled.status === 'ready') {
    const count = `${total}${capped ? '+' : ''}`
    if (total === 0) tone = 'text-danger'
    content =
      total === 0 ? 'No results' : active < 0 ? `${count} results` : `${active + 1} of ${count}`
  }
  return (
    <span
      id={id}
      role="status"
      className={clsx('shrink-0 text-sm tabular-nums', tone)}
      data-tooltip={!unavailable && compiled.status === 'invalid' ? compiled.error : undefined}
      data-testid="find-status"
    >
      {content}
    </span>
  )
}

/**
 * The floating find bar every in-surface search uses: field, match count,
 * case / word / regex toggles, previous / next, close.
 *
 * Keys, from anywhere in the bar: Enter / ⇧Enter and ⌘G / ⇧⌘G step, F3 too;
 * ⌥C ⌥W ⌥R toggle; ⌘F re-selects the field; Escape closes and returns focus.
 * Escape stops here — window listeners such as the sidebar's (drop a
 * selection) would otherwise act on the same press. Keys that commit or
 * cancel an IME composition belong to the IME.
 *
 * The surface supplies the count and the cursor: it knows where its matches
 * are. It sits in the top-right corner of the nearest positioned ancestor,
 * over the content; `revealRange` keeps a revealed match out from under it.
 */
export function FindBar({
  find,
  total,
  active,
  capped = false,
  onStep,
  placeholder = 'Find',
  unavailable,
  testId,
}: {
  find: FindState
  total: number
  /** Current match, 0-based; -1 for none. */
  active: number
  /** `total` is a floor: the surface stopped counting. */
  capped?: boolean
  onStep: (delta: 1 | -1) => void
  /** Also the bar's accessible name: "Find in session". */
  placeholder?: string
  /** Set while the surface shows something find cannot read; replaces the count. */
  unavailable?: FindUnavailable
  testId?: string
}): React.JSX.Element | null {
  const { inputRef, focusRequest, open, compiled } = find
  const statusId = useId()

  useLayoutEffect(() => {
    if (!open) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [open, focusRequest, inputRef])

  if (!open) return null

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
    const mod = event.metaKey || event.ctrlKey
    const toggle = optionForKey(event)
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      find.close()
    } else if (toggle) {
      event.preventDefault()
      find.toggleOption(toggle)
    } else if (
      (event.key === 'Enter' && event.target === inputRef.current && !mod) ||
      event.key === 'F3' ||
      (mod && event.code === 'KeyG')
    ) {
      event.preventDefault()
      onStep(event.shiftKey ? -1 : 1)
    } else if (mod && event.code === 'KeyF' && !event.shiftKey) {
      event.preventDefault()
      event.stopPropagation()
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }

  const stepDisabled = total === 0
  return (
    <div
      data-find-bar
      data-find-skip
      data-testid={testId}
      role="search"
      aria-label={placeholder}
      onKeyDown={onKeyDown}
      className="border-border bg-surface-raised focus-within:border-border-strong absolute right-3 top-2 z-20 flex items-center gap-1 rounded-lg border py-1 pl-2 pr-1 shadow-md"
    >
      <SearchIcon size={11} className="text-text-tertiary shrink-0" />
      <input
        ref={inputRef}
        value={find.query}
        onChange={(event) => find.setQuery(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        aria-invalid={compiled.status === 'invalid'}
        aria-describedby={statusId}
        spellCheck={false}
        className="find-field text-text placeholder:text-text-tertiary w-40 min-w-0 bg-transparent text-sm outline-none"
        data-tooltip={placeholder}
      />
      <FindStatus
        id={statusId}
        compiled={compiled}
        total={total}
        active={active}
        capped={capped}
        unavailable={unavailable}
      />
      {unavailable && (
        <TooltipButton
          type="button"
          title={unavailable.reason}
          onClick={unavailable.onAction}
          className="text-accent hover:text-accent-hover shrink-0 rounded px-0.5 text-sm transition-colors"
          data-testid="find-unavailable"
        >
          {unavailable.action}
        </TooltipButton>
      )}
      <SearchOptionToggles options={find.options} onToggle={find.toggleOption} />
      <span className="bg-border mx-0.5 h-4 w-px shrink-0" aria-hidden="true" />
      <BarButton
        label="Previous match"
        shortcut={formatShortcut('shift', 'Enter')}
        disabled={stepDisabled}
        onClick={() => onStep(-1)}
      >
        <ChevronDownIcon size={12} className="rotate-180" />
      </BarButton>
      <BarButton
        label="Next match"
        shortcut="Enter"
        disabled={stepDisabled}
        onClick={() => onStep(1)}
      >
        <ChevronDownIcon size={12} />
      </BarButton>
      <BarButton label="Close" shortcut="Esc" onClick={find.close}>
        <CloseIcon size={11} strokeWidth={2.5} />
      </BarButton>
    </div>
  )
}

function BarButton({
  label,
  shortcut,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  shortcut: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      title={`${label} (${shortcut})`}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="text-text-tertiary hover:text-text hover:bg-bg-secondary flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </TooltipButton>
  )
}

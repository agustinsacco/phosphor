import { useEffect, useRef, useState } from 'react'
import { ModalOverlay } from './Modal'
import { MenuRow } from './PopupMenu'
import { TooltipButton } from './Tooltip'
import { CloseIcon } from './icons'
import { usePlatform } from '@/platform/Platform'
import { ignoreShortcut } from '@/lib/shortcutContext'
import type { PaletteAction } from '@/features/palette/paletteStore'
import './PaletteDialog.css'

/** Full-screen on a phone; command-palette placement elsewhere. */
export function PaletteDialog({
  query,
  onQuery,
  matches,
  onRun,
  onClose,
}: {
  query: string
  onQuery: (query: string) => void
  matches: PaletteAction[]
  onRun: (action: PaletteAction) => void
  onClose: () => void
}): React.JSX.Element {
  const compact = usePlatform().formFactor === 'compact'
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const returnTo = useRef(document.activeElement)
  useEffect(() => {
    inputRef.current?.focus()
    const previous = returnTo.current
    return () => {
      if (document.activeElement && document.activeElement !== document.body) return
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <ModalOverlay
      shortcutOverlay="palette"
      onClose={onClose}
      align="top"
      className="palette-overlay"
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Search lanes and pages"
        data-shortcut-overlay="palette"
        className="palette-dialog"
      >
        <div className="palette-input-row">
          <input
            ref={inputRef}
            value={query}
            aria-label="Search lanes and pages"
            placeholder="Type a command…"
            className="palette-input"
            onChange={(e) => {
              onQuery(e.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={(e) => {
              if (ignoreShortcut(e.nativeEvent)) return
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                const count = Math.max(1, matches.length)
                setActiveIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : count - 1)) % count)
              } else if (e.key === 'Enter') {
                e.preventDefault()
                const action = matches[activeIndex]
                if (action) onRun(action)
              }
            }}
          />
          {compact && (
            <TooltipButton title="Close search" className="palette-close" onClick={onClose}>
              <CloseIcon size={18} />
            </TooltipButton>
          )}
        </div>
        <PaletteResults
          matches={matches}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          onRun={onRun}
        />
      </section>
    </ModalOverlay>
  )
}

function PaletteResults({
  matches,
  activeIndex,
  onHover,
  onRun,
}: {
  matches: PaletteAction[]
  activeIndex: number
  onHover: (index: number) => void
  onRun: (action: PaletteAction) => void
}): React.JSX.Element {
  return (
    <div className="palette-results">
      {matches.map((action, index) => (
        <MenuRow
          key={action.id}
          active={index === activeIndex}
          onHover={() => onHover(index)}
          onClick={() => onRun(action)}
        >
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg">{action.label}</span>
            {action.needsYou && <span className="text-warning text-sm">Needs you</span>}
          </span>
          {action.hint && (
            <span className="palette-hint text-text-tertiary text-xs">{action.hint}</span>
          )}
        </MenuRow>
      ))}
      {matches.length === 0 && (
        <div className="text-text-tertiary px-4 py-4 text-center text-base">
          No matching commands
        </div>
      )}
    </div>
  )
}

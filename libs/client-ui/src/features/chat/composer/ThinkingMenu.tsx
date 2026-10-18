import type { ThinkingLevel } from '@shared/rpc'
import { PopupMenu, MenuRow } from '@/components/PopupMenu'
import { CheckIcon } from '@/components/icons'

/** Chip/menu label for a level ("No thinking" reads better than "Off"). */
export function thinkingLabel(level: ThinkingLevel): string {
  return level === 'off' ? 'No thinking' : level.charAt(0).toUpperCase() + level.slice(1)
}

/**
 * Thinking-level menu shared by the session composer and the home picker.
 *
 * The data source differs by surface (pi's authoritative per-session answer
 * vs. local derivation from the catalogue) — the menu itself must not: the
 * two inline copies this replaces had already drifted (a private check glyph,
 * a duplicated title-case helper).
 */
export function ThinkingMenu({
  levels,
  current,
  onPick,
  onClose,
  className,
}: {
  levels: ThinkingLevel[]
  current: ThinkingLevel
  onPick: (level: ThinkingLevel) => void
  onClose: () => void
  className?: string
}): React.JSX.Element {
  return (
    <PopupMenu
      onClose={onClose}
      className={className ?? 'absolute bottom-full right-0 mb-2 w-40 max-w-[10rem] py-1'}
      fitViewport
    >
      {levels.map((level) => (
        <MenuRow key={level} active={false} onClick={() => onPick(level)}>
          <span className="flex-1">{thinkingLabel(level)}</span>
          {current === level && <CheckIcon className="text-text" />}
        </MenuRow>
      ))}
    </PopupMenu>
  )
}

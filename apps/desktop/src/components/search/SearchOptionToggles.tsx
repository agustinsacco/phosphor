import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import type { SearchOptions } from '@shared/text-search'
import { formatShortcut } from '@/lib/shortcuts'

/** The three toggles, their glyphs, and the ⌥ letter that flips each (VS Code's). */
const OPTION_TOGGLES: {
  key: keyof SearchOptions
  code: string
  letter: string
  label: string
  glyph: string
}[] = [
  { key: 'caseSensitive', code: 'KeyC', letter: 'C', label: 'Match case', glyph: 'Aa' },
  { key: 'wholeWord', code: 'KeyW', letter: 'W', label: 'Match whole word', glyph: 'ab' },
  { key: 'regex', code: 'KeyR', letter: 'R', label: 'Use regular expression', glyph: '.*' },
]

/**
 * ⌥C / ⌥W / ⌥R flip the toggles from the field. Matched on the physical key:
 * on macOS ⌥C types "ç", so `event.key` never says "c".
 */
export function optionForKey(event: React.KeyboardEvent): keyof SearchOptions | null {
  if (!event.altKey || event.metaKey || event.ctrlKey) return null
  return OPTION_TOGGLES.find((toggle) => toggle.code === event.code)?.key ?? null
}

/** Case / whole word / regex toggles, shared by the find bar and the workspace search panel. */
export function SearchOptionToggles({
  options,
  onToggle,
}: {
  options: SearchOptions
  onToggle: (key: keyof SearchOptions) => void
}): React.JSX.Element {
  return (
    <div className="flex shrink-0 items-center gap-px">
      {OPTION_TOGGLES.map((toggle) => {
        const title = `${toggle.label} (${formatShortcut('alt', toggle.letter)})`
        return (
          <TooltipButton
            key={toggle.key}
            type="button"
            title={title}
            aria-label={toggle.label}
            aria-pressed={options[toggle.key]}
            onClick={() => onToggle(toggle.key)}
            className={clsx(
              'flex h-5 min-w-5 items-center justify-center rounded px-0.5 font-mono text-2xs transition-colors',
              toggle.key === 'wholeWord' && 'underline decoration-1 underline-offset-2',
              options[toggle.key]
                ? 'bg-accent-soft text-accent'
                : 'text-text-tertiary hover:bg-bg-secondary hover:text-text',
            )}
          >
            {toggle.glyph}
          </TooltipButton>
        )
      })}
    </div>
  )
}

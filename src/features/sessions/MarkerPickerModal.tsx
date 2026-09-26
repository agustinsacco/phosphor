import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { laneMarker } from '@/lib/laneMarker'
import { MARKER_GROUPS, searchMarkers } from '@/lib/markerCatalog'

/**
 * Pick a lane's marker.
 *
 * Three outcomes, not two: a glyph, "Auto" (forget the choice and go back to
 * the branch-derived marker), and "None" (an explicit empty marker). Auto and
 * None look the same on a row that happens to be unmarked but mean different
 * things, and conflating them means you can never get back to Auto once you
 * have chosen anything.
 *
 * Glyphs already in use by another lane in the same group are dimmed rather
 * than disabled. Uniqueness is a nudge: enforcing it breaks the moment a
 * project has more lanes than the palette has glyphs.
 */
export function MarkerPickerModal({
  title,
  current,
  autoKey,
  mode,
  usedMarkers,
  onPick,
  onClose,
}: {
  title: string
  /** Explicit choice, or undefined when the lane is on Auto. */
  current: string | undefined
  /** Branch (or cwd) the Auto marker derives from. */
  autoKey: string | null | undefined
  mode: 'auto' | 'manual'
  usedMarkers: ReadonlySet<string>
  onPick: (marker: string | null) => void
  onClose: () => void
}): React.JSX.Element {
  const auto = laneMarker(undefined, autoKey, null, mode)
  const [query, setQuery] = useState('')
  const [group, setGroup] = useState('')
  const [limit, setLimit] = useState(120)
  const matches = useMemo(() => searchMarkers(query, group), [query, group])

  return (
    <ModalOverlay onClose={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Lane marker"
        className="bg-surface-raised border-border max-h-[90vh] w-[min(28rem,92vw)] overflow-y-auto rounded-lg border shadow-2xl"
      >
        <div className="border-border border-b px-4 py-3">
          <h2 className="text-base font-semibold">Lane marker</h2>
          <p className="text-text-secondary mt-0.5 truncate text-sm">{title}</p>
        </div>

        <div className="border-border flex items-center gap-2 border-b px-4 py-2">
          <button
            onClick={() => onPick(null)}
            className={clsx(
              'flex items-center gap-1.5 rounded-md border px-2 py-1 text-sm',
              current === undefined
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-border text-text-secondary hover:text-text',
            )}
            title={
              mode === 'auto'
                ? 'Derive the marker from the branch name'
                : 'No marker unless you pick one'
            }
          >
            <span>{auto}</span> {mode === 'auto' ? 'Auto' : 'Default'}
          </button>
          <button
            onClick={() => onPick('')}
            className={clsx(
              'rounded-md border px-2 py-1 text-sm',
              current === ''
                ? 'border-accent/40 bg-accent-soft text-accent'
                : 'border-border text-text-secondary hover:text-text',
            )}
            title="No marker for this lane"
          >
            None
          </button>
          <span className="text-text-tertiary ml-auto text-xs">dimmed = used by another lane</span>
        </div>

        <div className="space-y-2 px-4 pt-3">
          <input
            autoFocus
            aria-label="Search icons"
            placeholder="Search by name or paste an emoji…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setLimit(120)
            }}
            className="bg-surface border-border w-full rounded-md border px-3 py-2 text-sm"
          />
          <select
            aria-label="Icon category"
            value={group}
            onChange={(event) => {
              setGroup(event.target.value)
              setLimit(120)
            }}
            className="bg-surface border-border w-full rounded-md border px-2 py-1 text-sm"
          >
            <option value="">All categories</option>
            {MARKER_GROUPS.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
          <p role="status" className="text-text-tertiary text-xs">
            {matches.length
              ? `${matches.length.toLocaleString()} icons`
              : 'No icons found. Try another name or category.'}
          </p>
        </div>
        <div key={`${query}:${group}`} className="max-h-72 overflow-y-auto px-4 py-3">
          <div className="grid grid-cols-10 gap-1">
            {matches.slice(0, limit).map(({ glyph, name }) => (
              <button
                key={glyph}
                aria-label={name}
                aria-pressed={current === glyph}
                onClick={() => onPick(glyph)}
                title={`${name}${usedMarkers.has(glyph) ? ' (used by another lane)' : ''}`}
                className={clsx(
                  'grid h-8 place-items-center rounded-md text-lg',
                  current === glyph
                    ? 'bg-accent-soft ring-accent ring-1 ring-inset'
                    : 'hover:bg-sidebar-hover',
                  usedMarkers.has(glyph) && current !== glyph && 'opacity-35',
                )}
              >
                {glyph}
              </button>
            ))}
          </div>
          {matches.length > limit && (
            <button
              className="text-accent mt-3 w-full text-sm"
              onClick={() => setLimit(limit + 120)}
            >
              Show more icons
            </button>
          )}
        </div>
        <div className="border-border flex justify-end border-t px-4 py-2">
          <button onClick={onClose} className="text-text-secondary rounded-md px-2 py-1 text-sm">
            Cancel
          </button>
        </div>
      </div>
    </ModalOverlay>
  )
}

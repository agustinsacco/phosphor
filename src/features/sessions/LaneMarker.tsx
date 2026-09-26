/**
 * The emoji slot pinned left of a lane's title.
 *
 * Fixed width and ALWAYS rendered, including when the lane's marker is empty.
 * A slot that collapses on an unmarked lane shifts every title in the list, so
 * the left edge goes ragged and the eye has to re-find the title on each row —
 * which is the thing the marker column exists to prevent. An explicitly
 * cleared marker therefore renders a faint placeholder, not nothing.
 */
export function LaneMarker({
  marker,
  onPick,
}: {
  marker: string
  onPick?: () => void
}): React.JSX.Element {
  return (
    <span
      data-testid="lane-marker"
      aria-hidden={onPick ? undefined : true}
      role={onPick ? 'button' : undefined}
      aria-label={onPick ? 'Change lane marker' : undefined}
      title={onPick ? 'Change lane marker' : undefined}
      tabIndex={onPick ? -1 : undefined}
      onClick={
        onPick
          ? (event) => {
              event.stopPropagation()
              onPick()
            }
          : undefined
      }
      onDoubleClick={onPick ? (event) => event.stopPropagation() : undefined}
      className="w-[18px] shrink-0 text-center text-sm leading-4 select-none"
    >
      {marker || <span className="text-text-tertiary text-2xs opacity-60">•</span>}
    </span>
  )
}

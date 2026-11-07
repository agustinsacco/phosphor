/** Where a lane lives, on rows that mix folders or machines (Pinned, the Home board). */
export function LaneWorkspaceBadge({ name }: { name: string }): React.JSX.Element {
  return (
    <span
      data-testid="session-workspace-badge"
      className="bg-chip text-text-secondary shrink-0 rounded px-1.5 py-px text-2xs font-medium"
    >
      {name}
    </span>
  )
}

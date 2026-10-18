/** Small labeled metric tile (workspace home, usage view). */
export function StatTile({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="bg-surface border-border rounded-lg border px-3 py-2.5">
      <div className="text-text-tertiary font-mono text-xs uppercase tracking-wider">{label}</div>
      <div className="text-text mt-0.5 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  )
}

import type { BrainEntityKind } from '@shared/brain'
import { TooltipButton } from '@/components/Tooltip'
import { GRAPH_COLORS } from '../graphColors'

export function KindDot({ kind }: { kind: BrainEntityKind }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="mt-1.5 size-2 shrink-0 rounded-full"
      style={{ background: `var(${GRAPH_COLORS[kind]})` }}
    />
  )
}
export function EntityChip({
  label,
  kind,
  onClick,
}: {
  label: string
  kind?: BrainEntityKind
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      className="bg-chip hover:bg-bg-secondary inline-flex min-w-0 max-w-full items-start gap-1.5 rounded-md px-2 py-0.5 text-left text-sm [overflow-wrap:anywhere]"
    >
      {kind && <KindDot kind={kind} />}
      <span className="min-w-0">{label}</span>
    </TooltipButton>
  )
}

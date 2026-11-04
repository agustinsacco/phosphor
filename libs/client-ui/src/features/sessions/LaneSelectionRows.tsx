import { MenuRow } from '@/components/PopupMenu'

export type LaneSelectMode = 'all' | 'merged' | 'clear'
const SELECT_LABELS: Record<LaneSelectMode, string> = {
  all: 'Select all lanes',
  merged: 'Select merged lanes',
  clear: 'Clear selection',
}

/**
 * Select lanes for bulk delete, and collapse: a group's own rows in its
 * workspace menu, This Mac's and a Host folder's alike.
 */
export function LaneSelectionRows({
  canSelect,
  selecting,
  collapsed,
  onCollapse,
  onSelect,
  onDone,
}: {
  canSelect: boolean
  selecting: boolean
  collapsed: boolean
  onCollapse: (collapsed: boolean) => void
  onSelect: (mode: LaneSelectMode) => void
  onDone: () => void
}): React.JSX.Element {
  return (
    <>
      {([selecting ? 'clear' : 'all', 'merged'] as const).map((mode) => (
        <MenuRow
          key={mode}
          active={false}
          testId={mode === 'merged' ? 'workspace-group-select-merged' : 'workspace-group-select'}
          disabled={!canSelect}
          onClick={() => {
            onDone()
            onCollapse(false)
            onSelect(mode)
          }}
        >
          {SELECT_LABELS[mode]}
        </MenuRow>
      ))}
      <MenuRow
        active={false}
        onClick={() => {
          onCollapse(!collapsed)
          onDone()
        }}
      >
        {collapsed ? 'Expand' : 'Collapse'} lanes
      </MenuRow>
    </>
  )
}

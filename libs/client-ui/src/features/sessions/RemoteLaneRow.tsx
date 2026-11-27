import type { HostLaneView } from '@shared/ipc'
import { useMenuTriggers } from '@/components/ContextMenu'
import { useInlineRename } from './laneRowBody'
import { useNavigation } from '@/navigation/Navigation'
import { RemoteLanePresentation } from './RemoteLanePresentation'
import { LaneMarker } from './LaneMarker'
import { useRemoteLaneActions } from './useRemoteLaneActions'
import type { LaneSelect } from './LaneSelect'
export { remoteLaneTitle } from './remoteLaneView'

/**
 * The one Host lane row, on every surface that lists Host lanes: Desktop's
 * sidebar, the browser's navigation and Lanes page, Host home and the machine preview.
 * Its menu opens on right-click, the menu key or a touch long-press, and holds
 * the shared lane actions. Pins and markers are the Host's, so every client
 * shows the same ones. Curation uses durable Host/lane identities, never
 * transport handles.
 */
export function RemoteLaneRow({
  hostId,
  lane,
  ready,
  active = false,
  workspaceName,
  select,
}: {
  hostId: string
  lane: HostLaneView
  ready: boolean
  active?: boolean
  /** The lane's folder, shown where rows from several folders mix (Pinned). */
  workspaceName?: string
  /** The row's box in its folder's bulk-delete selection; absent where rows mix folders. */
  select?: Omit<LaneSelect, 'title'>
}): React.JSX.Element {
  const { navigate } = useNavigation()
  const actions = useRemoteLaneActions({ hostId, lane, ready, onRename: rename })
  const { title, canRename } = actions
  const menu = useMenuTriggers(actions.items, { title, disabled: !ready, ...actions.menuTrigger })
  const inline = useInlineRename(title, (name) => void actions.saveName(name), {
    maxLength: 80,
    label: 'Lane name',
  })
  function rename(): void {
    inline.begin()
  }
  return (
    <>
      {actions.dialogs}
      <RemoteLanePresentation
        hostId={hostId}
        lane={lane}
        title={title}
        titleEditor={inline.editor}
        ready={ready}
        disabled={!ready || actions.deletingInBulk}
        active={active}
        pinned={lane.pinned === true}
        workspaceName={workspaceName}
        select={select && !actions.deletingInBulk ? { ...select, title } : undefined}
        marker={
          actions.marker !== null && (
            <LaneMarker marker={actions.marker} onPick={actions.pickMarker} />
          )
        }
        onClick={(event) => {
          if (ready && event.detail <= 1)
            navigate({ to: 'lane', lane: { hostId, laneId: lane.laneId } })
        }}
        onDoubleClick={canRename ? rename : undefined}
        {...menu}
      />
    </>
  )
}

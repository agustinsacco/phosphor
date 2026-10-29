import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { useMenuTriggers } from '@/components/ContextMenu'
import { TextInput } from '@/components/form'
import { useNavigation } from '@/navigation/Navigation'
import { RemoteLanePresentation } from './RemoteLanePresentation'
import { LaneMarker } from './LaneMarker'
import { useRemoteLaneActions } from './useRemoteLaneActions'
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
}: {
  hostId: string
  lane: HostLaneView
  ready: boolean
  active?: boolean
  /** The lane's folder, shown where rows from several folders mix (Pinned). */
  workspaceName?: string
}): React.JSX.Element {
  const { navigate } = useNavigation()
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const actions = useRemoteLaneActions({ hostId, lane, ready, onRename: rename })
  const { title, busy } = actions
  const menu = useMenuTriggers(actions.items, { title, disabled: !ready })
  function rename(): void {
    setDraft(title === 'Untitled lane' ? '' : title)
    setRenaming(true)
  }
  async function save(): Promise<void> {
    if (await actions.saveName(draft)) setRenaming(false)
  }
  return (
    <>
      {actions.dialogs}
      {renaming ? (
        <div className="px-3 py-2">
          <TextInput
            autoFocus
            aria-label="Lane name"
            maxLength={80}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (!draft.trim()) setRenaming(false)
              else void save()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(false)
              if (e.key === 'Enter') void save()
            }}
          />
        </div>
      ) : (
        <RemoteLanePresentation
          hostId={hostId}
          lane={lane}
          title={title}
          ready={ready}
          disabled={!ready || actions.deletingInBulk}
          active={active}
          pinned={lane.pinned === true}
          workspaceName={workspaceName}
          marker={<LaneMarker marker={lane.marker ?? ''} onPick={actions.pickMarker} />}
          onClick={() => {
            if (ready) navigate({ to: 'lane', lane: { hostId, laneId: lane.laneId } })
          }}
          onDoubleClick={() => {
            if (actions.controlled && actions.running) rename()
          }}
          {...menu}
        />
      )}
    </>
  )
}

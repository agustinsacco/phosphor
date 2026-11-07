import { LocalLanePreviewRow } from '@/features/machines/LocalLanePreview'
import { RemoteLaneRow } from '@/features/sessions/RemoteLaneRow'
import { SectionLabel, WorkspaceGroupSkeletons } from '@/features/sessions/SidebarPrimitives'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { homeSections, type BoardLane } from './homeBoard'
import { useBoardLanes } from './useBoardLanes'

function BoardRow({ entry }: { entry: BoardLane }): React.JSX.Element {
  return entry.kind === 'host' ? (
    <RemoteLaneRow
      hostId={entry.hostId}
      lane={entry.lane}
      ready={entry.ready}
      workspaceName={entry.where}
    />
  ) : (
    <LocalLanePreviewRow lane={entry.lane} workspaceName={entry.where} />
  )
}

function Section({ title, lanes }: { title: string; lanes: BoardLane[] }) {
  if (!lanes.length) return null
  return (
    <section aria-label={title} className="home-board-section">
      <SectionLabel>
        {title} · {lanes.length}
      </SectionLabel>
      {lanes.map((entry) => (
        <BoardRow key={entry.key} entry={entry} />
      ))}
    </section>
  )
}

/**
 * Every machine's lanes in the order to look at them: what waits on you, what is running,
 * then where you were. The same board is Desktop's All machines home and the browser's
 * Home; each row is the machine's own lane row, menu included.
 */
export function HomeBoard(): React.JSX.Element {
  const lanes = useBoardLanes()
  const firstLoad = useRemoteLanesStore((s) => s.snapshotStatus === 'loading')
  const loadingMachines = useMachinesStore((s) => s.loading && s.machines.length === 0)
  const { needsYou, working, recent } = homeSections(lanes)
  if (!lanes.length)
    return firstLoad || loadingMachines ? (
      <WorkspaceGroupSkeletons />
    ) : (
      <p className="text-text-secondary px-2 py-4 text-base">
        No lanes yet. Start one with New lane.
      </p>
    )
  return (
    <div data-testid="home-board" className="home-board">
      <Section title="Needs you" lanes={needsYou} />
      <Section title="Working" lanes={working} />
      <Section title="Recent" lanes={recent} />
    </div>
  )
}

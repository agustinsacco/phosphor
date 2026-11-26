import { useMemo, type CSSProperties, type ReactNode, type Ref } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { useNavigation } from '@/navigation/Navigation'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useRemoteLaneTitle } from '@/features/sessions/RemoteLanePresentation'
import { remoteLaneMarker } from '@/features/sessions/remoteLaneView'
import {
  hostOrbit,
  orbitPoint,
  orbitStateText,
  orbitSummary,
  ORBIT_RING,
  type OrbitLane,
  type OrbitSummary,
} from './orbitLanes'
import { useOrbitRing } from './useOrbitRing'
import './hostOrbit.css'

const R = ORBIT_RING * 100

/**
 * Host home's dial: the Phosphor mark drawn large, with one dot per lane on its
 * shell. Dots run clockwise from twelve o'clock, most pressing first; the centre
 * reads out the number that matters until a dot is hovered or focused, then that
 * lane. The orbit turns only while a lane is working. The sidebar (or Lanes on a
 * phone) keeps the full list, so this never repeats it.
 */
export function HostOrbit({
  hostId,
  label,
  lanes,
  ready,
  status,
}: {
  hostId: string
  label: string
  lanes: readonly HostLaneView[]
  ready: boolean
  /** Takes the centre while the lanes cannot be read: loading, or why not. */
  status?: ReactNode
}): React.JSX.Element {
  const { navigate } = useNavigation()
  const orbit = useMemo(() => hostOrbit(lanes, ready), [lanes, ready])
  const ring = useOrbitRing(orbit.shown, (laneId) => {
    if (ready) navigate({ to: 'lane', lane: { hostId, laneId } })
  })
  const preview = orbit.shown.find((entry) => entry.lane.laneId === ring.previewId)
  const working = orbit.counts.working > 0
  return (
    <div
      role="group"
      aria-label={`Lanes on ${label}`}
      className="host-orbit"
      data-testid="host-orbit"
      data-working={working || undefined}
      style={{ '--orbit-count': Math.max(orbit.shown.length, 1) } as CSSProperties}
      {...ring.handlers}
    >
      <svg className="host-orbit-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle className="host-orbit-shell" cx="50" cy="50" r={R} />
        {/* The beacon's trail without its head: a head on the ring would read as a lane. */}
        {working && (
          <path className="host-orbit-sweep" d={`M${50 - R} 50A${R} ${R} 0 0 1 50 ${50 - R}`} />
        )}
      </svg>
      {orbit.shown.map((entry, index) => (
        <OrbitDot
          key={entry.lane.laneId}
          hostId={hostId}
          entry={entry}
          index={index}
          count={orbit.shown.length}
          tabStop={index === ring.tabStop}
          active={entry === preview}
          buttonRef={(node) => {
            ring.dots.current[index] = node
          }}
        />
      ))}
      <div className="host-orbit-core">
        {status ??
          (preview ? (
            <OrbitPreview
              hostId={hostId}
              entry={preview}
              picked={ring.picked === preview.lane.laneId}
              onOpen={() => ring.open(preview.lane.laneId)}
            />
          ) : (
            <OrbitRest summary={orbitSummary(orbit.counts, orbit.total)} />
          ))}
      </div>
    </div>
  )
}

function OrbitDot({
  hostId,
  entry,
  index,
  count,
  tabStop,
  active,
  buttonRef,
}: {
  hostId: string
  entry: OrbitLane
  index: number
  count: number
  tabStop: boolean
  active: boolean
  buttonRef: Ref<HTMLButtonElement>
}): React.JSX.Element {
  const title = useRemoteLaneTitle(entry.lane, hostId)
  const { x, y } = orbitPoint(index, count)
  return (
    <TooltipButton
      ref={buttonRef}
      type="button"
      // The centre names the lane under the pointer; a tooltip would cover the ring.
      tooltip={false}
      className="host-orbit-dot"
      data-lane-id={entry.lane.laneId}
      data-tone={entry.tone}
      data-active={active || undefined}
      aria-label={`${title}, ${orbitStateText(entry)}`}
      tabIndex={tabStop ? 0 : -1}
      style={{ left: `${x}%`, top: `${y}%` }}
    />
  )
}

function OrbitRest({ summary }: { summary: OrbitSummary }): React.JSX.Element {
  return (
    <>
      {summary.count !== undefined && <span className="host-orbit-count">{summary.count}</span>}
      <span className="host-orbit-label" data-tone={summary.tone}>
        {summary.label}
      </span>
      <span className="host-orbit-detail">{summary.detail}</span>
    </>
  )
}

/** The lane under the pointer or focus. A touch pick also offers Open: a tap only previews. */
function OrbitPreview({
  hostId,
  entry,
  picked,
  onOpen,
}: {
  hostId: string
  entry: OrbitLane
  picked: boolean
  onOpen: () => void
}): React.JSX.Element {
  const title = useRemoteLaneTitle(entry.lane, hostId)
  const markers = useLanePrefsStore((s) => s.lanes.markers)
  const marker = remoteLaneMarker(entry.lane, markers)
  return (
    <>
      {marker && (
        <span className="host-orbit-marker" aria-hidden="true">
          {marker}
        </span>
      )}
      <span className="host-orbit-title">{title}</span>
      <span className="host-orbit-state" data-tone={entry.tone}>
        {orbitStateText(entry)}
      </span>
      {picked && (
        <Button size="xs" variant="primary" className="mt-2" onClick={onOpen}>
          Open
        </Button>
      )}
    </>
  )
}

import { PhosphorLoader } from '@/components/PhosphorLoader'
import type { OpeningLane as OpeningLaneState } from '@/stores/sessions'

/** Matches `.opening-lane[data-leaving]` in index.css. */
export const OPENING_LANE_EXIT_MS = 200

/**
 * The lane you just clicked, before its pi process answers.
 *
 * Opening a lane from disk spawns a subprocess and replays a transcript. That
 * window is a second on a warm machine and several on a cold one, and until
 * this existed nothing on screen acknowledged the click: the previous lane
 * stayed rendered and interactive, so the app read as stuck rather than busy.
 *
 * An OVERLAY rather than a fourth state in App's main switch, for two reasons.
 * The lane underneath keeps its React tree (scroll position, composer, pane),
 * so an open that fails leaves the user exactly where they were. And one
 * placement then covers all three cases — over a chat, over the greeting
 * screen, over a chat that is still being created.
 *
 * `z-20` is the same layer as a fullscreen pane, so a global page (`z-30`)
 * still wins: a page is a destination the user chose, and this is transient.
 *
 * Motion: the overlay fades in after a short beat, so a warm open that lands
 * inside it never flashes a loading screen — the sidebar row has already
 * acknowledged the click on the same frame. On arrival it fades out over the
 * lane rather than cutting, so the handoff to the transcript (or its skeleton)
 * reads as one continuous motion. `leaving` is that exit; it stops taking
 * input the moment it starts.
 */
export function OpeningLane({
  lane,
  leaving = false,
}: {
  lane: OpeningLaneState
  leaving?: boolean
}): React.JSX.Element {
  return (
    <div
      data-testid="opening-lane"
      data-reason={lane.reason}
      data-leaving={leaving || undefined}
      aria-hidden={leaving || undefined}
      aria-busy={!leaving}
      className="opening-lane bg-bg absolute inset-0 z-20 flex flex-col items-center justify-center gap-3"
    >
      <PhosphorLoader decorative />
      <div className="opening-lane-copy flex max-w-md flex-col items-center gap-1 px-6 text-center">
        <span className="text-text-secondary text-base" data-testid="opening-lane-label">
          {lane.reason === 'restart' ? 'Restarting' : 'Opening'}
        </span>
        <span className="text-text truncate text-lg font-medium" title={lane.title}>
          {lane.title}
        </span>
        {/* Said out loud because it is the reason for the wait, and because a
            user who has just changed provider or account should know the lane
            is coming back rather than being replaced. */}
        <span className="text-text-tertiary text-base">
          {lane.reason === 'restart'
            ? 'Resuming this lane on the new setting…'
            : 'Starting its agent and replaying the transcript…'}
        </span>
      </div>
    </div>
  )
}

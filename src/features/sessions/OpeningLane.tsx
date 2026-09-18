import { PhosphorLoader } from '@/components/PhosphorLoader'
import type { OpeningLane as OpeningLaneState } from '@/stores/sessions'

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
 */
export function OpeningLane({ lane }: { lane: OpeningLaneState }): React.JSX.Element {
  return (
    <div
      data-testid="opening-lane"
      data-reason={lane.reason}
      className="bg-bg absolute inset-0 z-20 flex flex-col items-center justify-center gap-3"
    >
      <PhosphorLoader decorative />
      <div className="flex max-w-md flex-col items-center gap-1 px-6 text-center">
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

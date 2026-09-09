import { PhosphorLoader } from '@/components/PhosphorLoader'
import { ChatImage } from '@/features/chat/ChatImage'
import { UserText } from '@/features/chat/UserText'
import type { StartingChat as StartingChatState } from '@/stores/startingChat'

/**
 * The chat you just sent, before it has a session behind it.
 *
 * Stands in for `ChatView` for the few hundred milliseconds between Enter and
 * a live pi process. Its whole job is continuity: the message sits in the same
 * bubble, at the same width, in the same place it will occupy in the real
 * transcript, so when `activeSessionId` flips nothing on screen moves. Compare
 * the previous behaviour, where the home screen stayed up with the text still
 * in the composer and a 14px spinner as the only sign anything had happened.
 *
 * Deliberately NOT the real transcript with a fake session id: the chat store
 * is keyed by phosphorId, and inventing one would mean reconciling a placeholder
 * with the real session's items a moment later. A read-only echo has none of
 * that risk.
 *
 * Layout classes are copied from `MessageList` (`mx-auto max-w-3xl px-6`) and
 * `UserMessage` (`bg-user-bubble … rounded-xl px-4 py-2.5 text-lg`) rather
 * than shared: they are two files that must agree, and a shared wrapper would
 * put a component boundary inside the transcript's virtualised list for the
 * sake of one echo.
 */
export function StartingChat({ starting }: { starting: StartingChatState }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto pt-4">
        <div className="mx-auto w-full max-w-3xl px-6">
          <div className="flex flex-col items-end gap-1">
            {starting.images && starting.images.length > 0 && (
              <div className="flex flex-wrap justify-end gap-2">
                {starting.images.map((image, i) => (
                  <ChatImage key={i} image={image} className="max-h-40 rounded-lg" />
                ))}
              </div>
            )}
            <div className="bg-user-bubble max-w-[85%] rounded-xl px-4 py-2.5 text-lg">
              <UserText text={starting.prompt} />
            </div>
            {/* Same zero-height meta row the real bubble reserves, so the
                swap does not shift the message up by 16px. */}
            <div className="h-4" />
          </div>
        </div>
      </div>

      {/*
        One status line, in the place the composer's working strip occupies.
        It names the step because the steps have visibly different costs — a
        worktree is created on disk, then a process is spawned — and an
        unlabelled spinner in a window that has otherwise gone quiet reads as
        a hang. This is the label `startLabel` always produced and never
        showed anyone.
      */}
      <div className="flex items-center justify-center gap-2 pb-8 pt-4">
        <PhosphorLoader decorative />
        <span className="text-text-secondary text-base" data-testid="starting-chat-phase">
          {starting.phase === 'branching' ? 'Creating branch…' : 'Starting session…'}
        </span>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { currentBranchUserMessages, rewindToEntry, type BranchUserMessage } from './rewind'
import { useChatUiStore } from './uiState'
import { ModalOverlay } from '@/components/Modal'

/**
 * Pick a past user message and fork the session from just before it.
 *
 * Lists the current branch only, oldest first — including messages a
 * compaction summarised out of the transcript and image-only ones. NOT pi's
 * `get_fork_messages`, which lists every branch the file has ever had in
 * file order, so "the message before the last one" could sit on a thread
 * the user abandoned days ago.
 */
export function ForkPickerModal({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const open = useChatUiStore((s) => s.forkPickerFor === sessionId)
  // undefined while loading, null when the entries could not be read.
  const [candidates, setCandidates] = useState<BranchUserMessage[] | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setCandidates(undefined)
    let current = true
    void currentBranchUserMessages(sessionId).then((messages) => {
      if (current) setCandidates(messages)
    })
    return () => {
      current = false
    }
  }, [open, sessionId])

  if (!open) return null
  const close = (): void => useChatUiStore.getState().closeForkPicker()

  // One mechanism with the per-message rewind button, including the image
  // restore: both fork from an entry on the current branch, with its images.
  const fork = async (candidate: BranchUserMessage): Promise<void> => {
    setBusy(true)
    try {
      await rewindToEntry(sessionId, candidate.entryId, candidate.images)
      close()
    } finally {
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={close}>
      <div className="border-border bg-surface-raised max-h-[70vh] w-[540px] overflow-hidden rounded-xl border shadow-xl">
        <div className="border-border flex items-center justify-between border-b px-4 py-3">
          <div>
            <div className="text-lg font-semibold">Rewind to an earlier message</div>
            <div className="text-text-tertiary text-sm">
              The thread rewinds to just before the message you pick, and its text comes back in the
              composer to edit and resend.
            </div>
          </div>
          <button onClick={close} className="text-text-tertiary hover:text-text">
            ✕
          </button>
        </div>
        <div className="max-h-[52vh] overflow-y-auto p-2">
          {candidates === undefined && (
            <div className="text-text-tertiary animate-pulse px-3 py-6 text-center text-base">
              Loading…
            </div>
          )}
          {candidates === null && (
            <div className="text-text-tertiary px-3 py-6 text-center text-base">
              Couldn't read this session's messages.
            </div>
          )}
          {candidates?.length === 0 && (
            <div className="text-text-tertiary px-3 py-6 text-center text-base">
              No forkable user messages yet.
            </div>
          )}
          {candidates?.map((candidate, index) => (
            <button
              key={candidate.entryId}
              disabled={busy}
              onClick={() => void fork(candidate)}
              className="hover:bg-bg-secondary flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:opacity-50"
            >
              <span className="bg-bg-secondary text-text-tertiary mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold">
                {index + 1}
              </span>
              {candidate.text ? (
                <span className="text-text line-clamp-2 text-lg">{candidate.text}</span>
              ) : (
                <span className="text-text-tertiary text-lg italic">
                  {candidate.images?.length === 1
                    ? 'Image'
                    : `${candidate.images?.length ?? 0} images`}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </ModalOverlay>
  )
}

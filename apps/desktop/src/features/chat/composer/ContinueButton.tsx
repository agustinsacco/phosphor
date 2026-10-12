import { iconButtonClass } from '@/components/ComposerButtons'
import { ipcErrorText } from '@shared/errors'
import { piCallOk } from '@/lib/rpc'
import { useChatStore, type ChatSession } from '@/stores/chat'

function busy(session: ChatSession | undefined): boolean {
  return (
    !session ||
    session.resuming ||
    session.isStreaming ||
    session.isCompacting ||
    session.promptSentAt != null
  )
}

/** A plain prompt, independent of the composer's unsent draft and attachments. */
export function ContinueButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  const disabled = useChatStore((s) => busy(s.sessions[sessionId]))

  const send = async (): Promise<void> => {
    const chat = useChatStore.getState()
    // Read again at click time: the optimistic bubble locks out a second click
    // synchronously, before React renders or pi acknowledges the first prompt.
    if (busy(chat.sessions[sessionId])) return
    chat.setError(sessionId, null)
    chat.addUserMessage(sessionId, 'continue')
    try {
      await piCallOk(sessionId, { type: 'prompt', message: 'continue' })
    } catch (error) {
      chat.setError(sessionId, ipcErrorText(error))
    }
  }

  return (
    <button
      type="button"
      onClick={() => void send()}
      disabled={disabled}
      aria-label="Continue"
      title='Send "continue"'
      className={iconButtonClass}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m8 5 11 7-11 7Z" />
      </svg>
    </button>
  )
}

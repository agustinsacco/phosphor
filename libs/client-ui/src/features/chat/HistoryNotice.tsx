import { useChatStore } from '@/stores/chat'

/** A lane whose settled history is too large to load: stays until history loads. */
export function HistoryNotice({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const notice = useChatStore((s) => s.sessions[sessionId]?.historyNotice)
  return notice ? (
    <p role="status" className="text-text-secondary mx-auto w-full max-w-3xl px-6 py-2 text-sm">
      {notice}
    </p>
  ) : null
}

import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'

export function EmptyTranscript({ sessionId }: { sessionId: string }): React.JSX.Element {
  const remote = useSessionsStore((s) => s.live[sessionId]?.target?.kind === 'remote')
  const hasHistory = useChatStore((s) => {
    const chat = s.sessions[sessionId]
    return !!chat?.historyNotice || (remote && (chat?.meta?.messageCount ?? 0) > 0)
  })
  // The notice belongs above the transcript; keep its space without a second message.
  if (hasHistory) return <div className="flex-1" />
  return (
    <div className="transcript-enter flex flex-1 items-center justify-center">
      <div className="text-center">
        <div className="text-text-secondary text-2xl font-medium tracking-tight">
          Describe a task to begin
        </div>
        <div className="text-text-tertiary mt-1.5 text-lg">
          pi runs with full permissions in this workspace — markdown, diffs, diagrams and previews
          render right here.
        </div>
      </div>
    </div>
  )
}

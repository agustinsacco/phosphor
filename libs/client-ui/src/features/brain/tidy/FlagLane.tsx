import { sessionTitle } from '@/lib/sessionTitle'
import type { BrainTidyProblem, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { navigateToLane } from '@/stores/remoteLanes'
import { ipcErrorText } from '@shared/errors'
import { brainToast } from '../useBrain'
import { openBrainSource } from '../openBrainSource'

const FLAG_SENTENCE: Record<BrainTidyProblem, string> = {
  wrong: 'says this is wrong.',
  outdated: 'says this is outdated.',
  duplicate: 'says this is a duplicate.',
}
/** Who flagged what, naming the lane as Phosphor's own lane list does, never the flag's claim. */
export function FlagLane({
  flag,
}: {
  flag: NonNullable<BrainTidySuggestionDetail['suggestion']['flag']>
}): React.JSX.Element {
  const lane = useSessionsStore((s) =>
    Object.values(s.disk)
      .flat()
      .find((lane) => lane.sessionId === flag.sessionId),
  )
  const path = lane?.path
  const live = useSessionsStore((s) => s.live)
  const liveId = useChatStore((s) =>
    Object.keys(live).find(
      (id) =>
        live[id]?.target?.kind !== 'remote' && s.sessions[id]?.meta?.sessionId === flag.sessionId,
    ),
  )
  const title = useChatStore((s) => {
    const chat = liveId ? s.sessions[liveId] : undefined
    const first = chat?.items.find((item) => item.kind === 'user')
    return sessionTitle({
      explicitName: chat?.meta?.sessionName ?? lane?.name,
      firstUserText: (first?.kind === 'user' ? first.text : undefined) ?? lane?.firstUserText,
    })
  })
  return (
    <div className="space-y-2">
      <p>
        {lane || liveId ? (title ?? 'Untitled lane') : `A lane calling itself ${flag.title}`}{' '}
        {FLAG_SENTENCE[flag.problem]}
      </p>
      <Button
        disabled={!path && !liveId}
        tooltip={path || liveId ? 'Open the lane' : 'The lane is no longer on this computer.'}
        onClick={() => {
          const opening = liveId
            ? navigateToLane({ sessionId: liveId })
            : path
              ? openBrainSource(path)
              : null
          opening?.catch((e: unknown) => brainToast(ipcErrorText(e), 'error'))
        }}
      >
        Open the lane
      </Button>
    </div>
  )
}

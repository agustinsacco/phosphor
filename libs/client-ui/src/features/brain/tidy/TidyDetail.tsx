import { useState } from 'react'
import { sessionTitle } from '@/lib/sessionTitle'
import type { BrainTidyAction, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { navigateToLane } from '@/stores/remoteLanes'
import { promptChoice } from '@/stores/prompt'
import { ipcErrorText } from '@shared/errors'
import { brainToast } from '../useBrain'
import { openBrainSource } from '../openBrainSource'
import { useBrainModelName } from '../useBrainModelName'
import type { BrainVisit } from '../explorer/trail'
import { TidySubjects } from './TidySubjects'

export function TidyDetail({
  data,
  busy,
  onApply,
  onDismiss,
  onVisit,
}: {
  data: BrainTidySuggestionDetail
  busy: boolean
  onApply: (action: BrainTidyAction) => void
  onDismiss: () => void
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const { suggestion, subjects } = data
  const [survivor, setSurvivor] = useState(
    () =>
      [...subjects].sort(
        (a, b) =>
          (b.type === 'entity' ? b.value.entity.memories : 0) -
          (a.type === 'entity' ? a.value.entity.memories : 0),
      )[0],
  )
  const survivorId = survivor?.type === 'entity' ? survivor.value.entity.id : ''
  const survivorLabel = survivor?.type === 'entity' ? survivor.value.entity.label : ''
  const allowed = suggestion.state === 'open' ? data.allowed : []
  const perSide = (id: string): React.ReactNode => (
    <div className="flex flex-wrap gap-2">
      {allowed.includes('fold') && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'fold', survivorId: id })}>
          Keep this one
        </Button>
      )}
      {allowed.includes('replace') && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'replace', newerId: id })}>
          This one replaces that one
        </Button>
      )}
    </div>
  )
  return (
    <article className="space-y-4 p-3 [overflow-wrap:anywhere]" aria-label="Tidy suggestion">
      <TidyVerdict suggestion={suggestion} />
      {suggestion.flag && <FlagLane flag={suggestion.flag} />}
      {!allowed.includes('fold') && data.foldRefusal && (
        <p className="text-text-secondary text-sm">
          {data.foldRefusal === 'applicability'
            ? 'These apply to different projects or branches, so they cannot be folded into one.'
            : 'One of these already replaced or disputes another memory, so they cannot be folded into one.'}
        </p>
      )}
      <TidySubjects subjects={subjects} onVisit={onVisit} action={perSide} />
      <TidyFooter
        allowed={allowed}
        open={suggestion.state === 'open'}
        busy={busy}
        onApply={onApply}
        onDismiss={onDismiss}
        survivorId={survivorId}
        survivorLabel={survivorLabel}
        onSwap={() => setSurvivor(subjects.find((s) => s !== survivor))}
      />
    </article>
  )
}
async function confirmForget(apply: (action: BrainTidyAction) => void): Promise<void> {
  if (
    (await promptChoice({
      title: 'Forget this memory?',
      message:
        'This permanently removes the memory and its saved undo history. Forget cannot be undone.',
      choices: [{ value: 'forget', label: 'Forget permanently' }],
    })) === 'forget'
  )
    apply({ kind: 'forget' })
}
function FlagLane({
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
        {flag.problem} ·{' '}
        {lane || liveId ? (title ?? 'Untitled lane') : `A lane calling itself ${flag.title}`}
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

function TidyFooter({
  allowed,
  open,
  busy,
  onApply,
  onDismiss,
  survivorId,
  survivorLabel,
  onSwap,
}: {
  allowed: BrainTidyAction['kind'][]
  open: boolean
  busy: boolean
  onApply: (action: BrainTidyAction) => void
  onDismiss: () => void
  survivorId: string
  survivorLabel: string
  onSwap: () => void
}): React.JSX.Element {
  return (
    <footer className="flex flex-wrap items-center gap-2">
      {allowed.includes('merge') && (
        <>
          <Button disabled={busy} onClick={() => onApply({ kind: 'merge', survivorId })}>
            Merge into {survivorLabel}
          </Button>
          <Button disabled={busy} onClick={onSwap}>
            Swap surviving record
          </Button>
        </>
      )}
      {allowed.includes('dispute') && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'dispute' })}>
          Keep both as disputed
        </Button>
      )}
      {allowed.includes('forget') && (
        <Button
          disabled={busy}
          variant="danger"
          onClick={() => {
            void confirmForget(onApply)
          }}
        >
          Forget
        </Button>
      )}
      {allowed.includes('keep') && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'keep' })}>
          Keep
        </Button>
      )}
      {open && (
        <Button disabled={busy} onClick={onDismiss}>
          Not the same
        </Button>
      )}
    </footer>
  )
}

function TidyVerdict({
  suggestion,
}: {
  suggestion: BrainTidySuggestionDetail['suggestion']
}): React.JSX.Element {
  const model = useBrainModelName(suggestion.model ?? '')
  const newerId = suggestion.verdict?.kind === 'replaces' ? suggestion.verdict.newerId : null
  return (
    <header className="space-y-2">
      <p className="font-medium">{suggestion.reason}</p>
      <p className="text-text-tertiary text-sm">
        {suggestion.verdict
          ? `Checked by ${model}`
          : suggestion.source === 'sweep'
            ? 'Found on this computer'
            : 'Flagged by a lane'}
      </p>
      {suggestion.verdict && (
        <p>
          {suggestion.verdict.reason}
          {suggestion.verdict.kind === 'replaces' &&
            ` Newer truth: ${suggestion.subjects.find((s) => s.id === newerId)?.label ?? ''}`}
        </p>
      )}
    </header>
  )
}

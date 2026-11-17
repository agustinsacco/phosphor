import { useState } from 'react'
import type { BrainTidyAction, BrainTidySuggestionDetail } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { useSessionsStore } from '@/stores/sessions'
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
  const model = useBrainModelName(suggestion.model ?? '')
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
  const kind = suggestion.kind
  const newerId = suggestion.verdict?.kind === 'replaces' ? suggestion.verdict.newerId : null
  const perSide = (id: string): React.ReactNode =>
    kind === 'same_memory' ? (
      <Button disabled={busy} onClick={() => onApply({ kind: 'fold', survivorId: id })}>
        Keep this one
      </Button>
    ) : kind === 'conflict' ? (
      <Button disabled={busy} onClick={() => onApply({ kind: 'replace', newerId: id })}>
        This one replaces that one
      </Button>
    ) : null
  return (
    <article className="space-y-4 p-3 [overflow-wrap:anywhere]" aria-label="Tidy suggestion">
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
      {suggestion.flag && <FlagLane flag={suggestion.flag} />}
      <TidySubjects subjects={subjects} onVisit={onVisit} action={perSide} />
      <TidyFooter
        kind={kind}
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
  const path = useSessionsStore(
    (s) =>
      Object.values(s.disk)
        .flat()
        .find((lane) => lane.sessionId === flag.sessionId)?.path,
  )
  return (
    <div className="space-y-2">
      <p>
        {flag.problem} · {flag.title}
      </p>
      <Button
        disabled={!path}
        tooltip={path ? 'Open the lane' : 'The lane is no longer on this computer.'}
        onClick={() => {
          if (path)
            openBrainSource(path).catch((e: unknown) => brainToast(ipcErrorText(e), 'error'))
        }}
      >
        Open the lane
      </Button>
    </div>
  )
}

function TidyFooter({
  kind,
  busy,
  onApply,
  onDismiss,
  survivorId,
  survivorLabel,
  onSwap,
}: {
  kind: BrainTidySuggestionDetail['suggestion']['kind']
  busy: boolean
  onApply: (action: BrainTidyAction) => void
  onDismiss: () => void
  survivorId: string
  survivorLabel: string
  onSwap: () => void
}): React.JSX.Element {
  return (
    <footer className="flex flex-wrap items-center gap-2">
      {kind === 'same_entity' && (
        <>
          <Button disabled={busy} onClick={() => onApply({ kind: 'merge', survivorId })}>
            Merge into {survivorLabel}
          </Button>
          <Button disabled={busy} onClick={onSwap}>
            Swap surviving record
          </Button>
        </>
      )}
      {kind === 'conflict' && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'dispute' })}>
          Keep both as disputed
        </Button>
      )}
      {kind === 'flagged' ? (
        <>
          <Button
            disabled={busy}
            variant="danger"
            onClick={() => {
              void confirmForget(onApply)
            }}
          >
            Forget
          </Button>
          <Button disabled={busy} onClick={() => onApply({ kind: 'keep' })}>
            Keep
          </Button>
        </>
      ) : (
        <Button disabled={busy} onClick={onDismiss}>
          {kind === 'conflict' ? 'Not a conflict' : 'Not the same'}
        </Button>
      )}
    </footer>
  )
}

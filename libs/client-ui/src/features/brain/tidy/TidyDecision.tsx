import { useEffect, useState } from 'react'
import type {
  BrainTidyAction,
  BrainTidyPage,
  BrainTidySuggestion,
  BrainTidySuggestionDetail,
} from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { promptChoice } from '@/stores/prompt'
import { useBrainModelName } from '../useBrainModelName'
import type { BrainVisit } from '../explorer/trail'
import { DecisionBar, DecisionFrame, type DecisionKeys } from '../inbox/DecisionFrame'
import { INBOX_GROUP_LABELS } from '../inbox/inboxItems'
import { TidySubjects } from './TidySubjects'
import { FlagLane } from './FlagLane'
import { useTidyDetail } from './useTidyDetail'
import { useTidyActions } from './useTidyActions'
import { tidyEntityPair, tidyOpinion, tidyTitle } from './tidyWording'

/** One Tidy suggestion in the Inbox frame: both sides, the reason, and its actions in the bar. */
export function TidyDecision({
  suggestion,
  page,
  reload,
  keys,
  onContext,
  onVisit,
}: {
  suggestion: BrainTidySuggestion
  page: BrainTidyPage | null
  reload: () => Promise<BrainTidyPage | null>
  keys: React.RefObject<DecisionKeys>
  onContext: (entityIds: string[]) => void
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const detail = useTidyDetail(suggestion.id)
  const actions = useTidyActions({
    detail: detail.data,
    page,
    reload,
    reloadDetail: detail.reload,
    suggestionId: suggestion.id,
  })
  const data = detail.data
  useEffect(() => {
    onContext(
      data?.subjects.flatMap((subject) =>
        subject.type === 'entity'
          ? [subject.value.entity.id]
          : subject.value.memory.entityIds.slice(0, 3),
      ) ?? [],
    )
  }, [data, onContext])
  const settled = detail.loaded && data?.suggestion.state !== 'open'
  useEffect(() => {
    if (settled) void reload()
  }, [settled, reload])
  const frame = {
    label: 'Tidy suggestion',
    eyebrow: INBOX_GROUP_LABELS[suggestion.kind],
    title: tidyTitle(suggestion),
  }
  if (!data || settled)
    return (
      <DecisionFrame {...frame}>
        <p role="status">
          {settled ? 'This suggestion was already settled.' : detail.error || 'Loading suggestion…'}{' '}
          {detail.error && <Button onClick={detail.retry}>Retry</Button>}
        </p>
      </DecisionFrame>
    )
  return (
    <TidyDetailFrame
      key={`${data.suggestion.id}:${data.revision}`}
      frame={frame}
      data={data}
      busy={actions.busy}
      message={actions.message}
      keys={keys}
      onApply={actions.apply}
      onDismiss={actions.dismiss}
      onVisit={onVisit}
    />
  )
}

function TidyDetailFrame({
  frame,
  data,
  busy,
  message,
  keys,
  onApply,
  onDismiss,
  onVisit,
}: {
  frame: { label: string; eyebrow: string; title: string }
  data: BrainTidySuggestionDetail
  busy: boolean
  message: string
  keys: React.RefObject<DecisionKeys>
  onApply: (action: BrainTidyAction) => void
  onDismiss: () => void
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const { suggestion, subjects } = data
  const allowed = data.allowed
  const pair = tidyEntityPair(data)
  const perSide = (id: string): React.ReactNode => (
    <div className="flex flex-wrap gap-2">
      {allowed.includes('fold') && (
        <Button size="sm" disabled={busy} onClick={() => onApply({ kind: 'fold', survivorId: id })}>
          Keep this one
        </Button>
      )}
      {allowed.includes('replace') && (
        <Button size="sm" disabled={busy} onClick={() => onApply({ kind: 'replace', newerId: id })}>
          This one replaces the other
        </Button>
      )}
    </div>
  )
  useEffect(() => {
    const first = subjects[0]?.value
    const primary: BrainTidyAction | null =
      pair && allowed.includes('merge')
        ? { kind: 'merge', survivorId: pair.a.id }
        : allowed.includes('fold') && first && 'memory' in first
          ? { kind: 'fold', survivorId: first.memory.id }
          : allowed.includes('dispute')
            ? { kind: 'dispute' }
            : allowed.includes('keep')
              ? { kind: 'keep' }
              : null
    keys.current = { primary: primary && !busy ? () => onApply(primary) : undefined }
  })
  return (
    <DecisionFrame
      {...frame}
      bar={
        <DecisionBar error={message}>
          <TidyBarActions data={data} busy={busy} onApply={onApply} onDismiss={onDismiss} />
        </DecisionBar>
      }
    >
      <TidyReason suggestion={suggestion} />
      {suggestion.flag && <FlagLane flag={suggestion.flag} />}
      {!allowed.includes('fold') && data.foldRefusal && (
        <p className="text-text-secondary text-sm">
          {data.foldRefusal === 'applicability'
            ? 'These apply to different projects or branches, so they cannot be folded into one.'
            : 'One of these already replaced or disputes another memory, so they cannot be folded into one.'}
        </p>
      )}
      <TidySubjects subjects={subjects} onVisit={onVisit} action={perSide} />
    </DecisionFrame>
  )
}

function TidyReason({ suggestion }: { suggestion: BrainTidySuggestion }): React.JSX.Element {
  const model = useBrainModelName(suggestion.model ?? '')
  return (
    <header className="space-y-1">
      <p className="font-medium">{suggestion.reason}</p>
      <p className="text-text-secondary text-sm">{tidyOpinion(suggestion, model)}</p>
    </header>
  )
}

function TidyBarActions({
  data,
  busy,
  onApply,
  onDismiss,
}: {
  data: BrainTidySuggestionDetail
  busy: boolean
  onApply: (action: BrainTidyAction) => void
  onDismiss: () => void
}): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const allowed = data.allowed
  const pair = tidyEntityPair(data)
  const pairOpen = data.suggestion.kind !== 'flagged'
  return (
    <>
      {pair && allowed.includes('merge') && (
        <>
          <Button
            variant="primary"
            disabled={busy}
            tooltip={{ label: `Merge ${pair.b.label} into ${pair.a.label}`, shortcut: ['A'] }}
            onClick={() => onApply({ kind: 'merge', survivorId: pair.a.id })}
          >
            Merge into {pair.a.label}
          </Button>
          <Button disabled={busy} onClick={() => onApply({ kind: 'merge', survivorId: pair.b.id })}>
            Keep {pair.b.label} instead
          </Button>
        </>
      )}
      {allowed.includes('dispute') && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'dispute' })}>
          Keep both as disputed
        </Button>
      )}
      {allowed.includes('keep') && (
        <Button disabled={busy} onClick={() => onApply({ kind: 'keep' })}>
          Keep
        </Button>
      )}
      {allowed.includes('forget') && (
        <Button
          variant="danger"
          disabled={busy || confirming}
          onClick={() => {
            setConfirming(true)
            void confirmForget(onApply).finally(() => setConfirming(false))
          }}
        >
          Forget
        </Button>
      )}
      {pairOpen && (
        <Button disabled={busy} onClick={onDismiss}>
          Not the same
        </Button>
      )}
    </>
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

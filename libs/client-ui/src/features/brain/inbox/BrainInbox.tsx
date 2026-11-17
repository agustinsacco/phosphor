import { useEffect, useMemo, useRef, useState } from 'react'
import { useBrain } from '../useBrain'
import type { useTidyPage } from '../tidy/useTidyPage'
import { TidyDecision } from '../tidy/TidyDecision'
import type { BrainVisit } from '../explorer/trail'
import { pageKeyTarget } from '../pageKeys'
import { InboxQueue } from './InboxQueue'
import { InboxContext } from './InboxContext'
import { ReviewDecision } from './ReviewDecision'
import { TidyRunControls } from './TidyRunControls'
import type { DecisionKeys } from './DecisionFrame'
import { inboxGroups, inboxOrder, keepInboxSelection, moveInboxSelection } from './inboxItems'

/** Every decision in one queue: lane reads to review first, then Tidy suggestions by kind. */
export function BrainInbox({
  tidy,
  selected,
  onSelect,
  onEntity,
  onVisit,
}: {
  tidy: ReturnType<typeof useTidyPage>
  selected: string | null
  onSelect: (key: string | null) => void
  onEntity: (id: string, label: string) => void
  onVisit: (visit: BrainVisit) => void
}): React.JSX.Element {
  const jobs = useBrain((s) => s.status!.jobs)
  const groups = inboxGroups(jobs, tidy.page)
  const items = inboxOrder(groups)
  const previous = useRef<string[]>([])
  // A notice can ask for a suggestion before its page has loaded.
  const waiting = !tidy.page && !!selected?.startsWith('suggestion:')
  const current = waiting ? selected : keepInboxSelection(previous.current, items, selected)
  const order = items.map((item) => item.key).join('\n')
  useEffect(() => {
    previous.current = order ? order.split('\n') : []
    if (current !== selected) onSelect(current)
  }, [order, current, selected, onSelect])
  // A fresh holder per item: a decision still loading never answers for the previous one.
  const keys = useMemo<React.RefObject<DecisionKeys>>(() => ({ current: {} }), [current])
  const [context, setContext] = useState<string[]>([])
  const item = items.find((entry) => entry.key === current)
  const onKeyDown = (event: React.KeyboardEvent): void => {
    for (const key of ['j', 'k', 'a', 'r'])
      if (pageKeyTarget(event, key)) {
        event.preventDefault()
        if (key === 'j' || key === 'k')
          onSelect(moveInboxSelection(items, current, key === 'j' ? 1 : -1))
        else if (key === 'a') keys.current.primary?.()
        else if (item?.kind === 'review') keys.current.reject?.()
      }
  }
  return (
    <div className="brain-panes brain-inbox" onKeyDown={onKeyDown}>
      <section aria-label="Decisions" className="brain-pane brain-pane--side brain-pane--start">
        <div className="brain-scroll">
          <InboxQueue
            groups={groups}
            selected={current}
            onSelect={onSelect}
            page={tidy.page}
            error={tidy.error}
            loading={tidy.loading}
            onRetry={() => {
              void tidy.reload()
            }}
            onMore={() => {
              void tidy.reload(true)
            }}
          />
        </div>
        <TidyRunControls page={tidy.page} reload={tidy.reload} />
      </section>
      <section aria-label="Decision" className="brain-pane">
        {item?.kind === 'review' ? (
          <ReviewDecision
            key={item.key}
            job={item.job}
            keys={keys}
            onContext={setContext}
            onMemory={(id, label) => onVisit({ kind: 'memory', id, label })}
          />
        ) : item ? (
          <TidyDecision
            key={item.key}
            suggestion={item.suggestion}
            page={tidy.page}
            reload={tidy.reload}
            keys={keys}
            onContext={setContext}
            onVisit={onVisit}
          />
        ) : (
          <p className="text-text-tertiary p-6">{tidy.page ? 'Nothing to decide.' : 'Loading…'}</p>
        )}
      </section>
      <aside
        aria-label="What Brain knows"
        className="brain-pane brain-pane--side brain-pane--end brain-pane--context brain-scroll"
      >
        <InboxContext key={current ?? ''} entityIds={item ? context : []} onEntity={onEntity} />
      </aside>
    </div>
  )
}

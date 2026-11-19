import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrainTidyPage, BrainTidySuggestion } from '@shared/brain-tidy'
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
import {
  heldSuggestion,
  inboxGroups,
  inboxOrder,
  keepInboxSelection,
  moveInboxSelection,
  type InboxItem,
} from './inboxItems'

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
  const { held, onSettled } = useHeldSuggestion(tidy.page, selected)
  const groups = inboxGroups(jobs, tidy.page, held)
  const items = inboxOrder(groups)
  // A notice can ask for a suggestion before its page has loaded.
  const waiting = !tidy.page && !!selected?.startsWith('suggestion:')
  const current = useInboxSelection(items, selected, onSelect, waiting)
  // Each decision fills this while mounted and empties it on unmount, so one still loading
  // never answers for the previous one.
  const keys = useRef<DecisionKeys>({})
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
          <InboxQueue groups={groups} selected={current} onSelect={onSelect} tidy={tidy} />
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
            onSettled={onSettled}
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

/** The open suggestion as last loaded, held in the queue while it is still open (heldSuggestion). */
function useHeldSuggestion(page: BrainTidyPage | null, selected: string | null) {
  const [seen, setSeen] = useState<BrainTidySuggestion | null>(null)
  const [settled, setSettled] = useState<string | null>(null)
  const loaded = page?.items.find(
    (item) => item.state === 'open' && `suggestion:${item.id}` === selected,
  )
  if (loaded && loaded !== seen) setSeen(loaded)
  const onSettled = useCallback((id: string) => setSettled(`suggestion:${id}`), [])
  return { held: heldSuggestion(page, loaded ?? seen, selected, settled), onSettled }
}

/** The selection in force: kept while it exists, else the item after it, then before it. */
function useInboxSelection(
  items: InboxItem[],
  selected: string | null,
  onSelect: (key: string | null) => void,
  waiting: boolean,
): string | null {
  const previous = useRef<string[]>([])
  const current = waiting ? selected : keepInboxSelection(previous.current, items, selected)
  const order = items.map((item) => item.key).join('\n')
  useEffect(() => {
    previous.current = order ? order.split('\n') : []
    if (current !== selected) onSelect(current)
  }, [order, current, selected, onSelect])
  return current
}

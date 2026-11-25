import type { ChatItem, DividerItem } from '../chatItems'
import { dayLabel, isSameLocalDay } from '@/lib/time'

/**
 * Day dividers for the transcript.
 *
 * A long lane is the one place in the app where a reader loses the date: a
 * run that started before midnight and a diff read after it look identical.
 * Every chat surface solves this the same way — orient ONCE per calendar day
 * and keep the clock time quiet (a day divider in Slack and ChatGPT,
 * `Today 1:25 AM` in iMessage) — because a timestamp on every message is
 * noise the reader stops seeing. So this marks the boundaries and the user
 * bubble carries the hour (`items/UserMessage.tsx`); the two together are the
 * date and the time without a second of hover.
 *
 * It runs on the rows the transcript renders, never on the store: these items
 * are view-model furniture, so pi's context, the message counts and rewind's
 * timestamp lookup — which matches a row to an entry by its own timestamp —
 * all still see exactly the items pi emitted.
 */

/** The timestamp a row can be oriented by, if its item carries one. */
function timestampOf(item: ChatItem): number | undefined {
  return item.kind === 'user' || item.kind === 'assistant' || item.kind === 'custom'
    ? item.timestamp
    : undefined
}

function dayDivider(itemId: string, at: number): DividerItem {
  return { id: `${itemId}-day`, kind: 'divider', variant: 'day', summary: dayLabel(at), at }
}

/**
 * Copy of `items` with a `day` divider before the first item of each day.
 *
 * Ids derive from the item the divider sits above, so they are stable across
 * every delta of a stream: a divider that changed id would remount its row,
 * and the virtualizer would jump the reader mid-turn.
 *
 * Items with no timestamp (a bash run, a compaction cut) neither start a day
 * nor end one — the day last seen still governs what follows them.
 */
export function withDayDividers(items: ChatItem[]): ChatItem[] {
  const out: ChatItem[] = []
  let lastSeen: number | undefined
  for (const item of items) {
    const ts = timestampOf(item)
    if (ts !== undefined) {
      if (lastSeen === undefined || !isSameLocalDay(lastSeen, ts)) {
        out.push(dayDivider(item.id, ts))
      }
      lastSeen = ts
    }
    out.push(item)
  }
  return out
}

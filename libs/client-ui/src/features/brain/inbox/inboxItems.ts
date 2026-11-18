import type { BrainJob, BrainStatus } from '@shared/brain'
import type { BrainTidyKind, BrainTidyPage, BrainTidySuggestion } from '@shared/brain-tidy'

/** One decision waiting in the Inbox: a lane read to review, or a Tidy suggestion. */
export type InboxItem =
  | { key: string; kind: 'review'; job: BrainJob }
  | { key: string; kind: 'suggestion'; suggestion: BrainTidySuggestion }
export type InboxGroupId = 'lanes' | BrainTidyKind
export const INBOX_GROUPS: readonly InboxGroupId[] = [
  'lanes',
  'same_entity',
  'same_memory',
  'conflict',
  'flagged',
]
export const INBOX_GROUP_LABELS: Record<InboxGroupId, string> = {
  lanes: 'From lanes',
  same_entity: 'Same person or thing?',
  same_memory: 'Said twice',
  conflict: 'These disagree',
  flagged: 'Flagged by a lane',
}
export interface InboxGroup {
  id: InboxGroupId
  label: string
  items: InboxItem[]
  /** Every item of this kind, including suggestions on pages not loaded yet. */
  total: number
}

/** A review waits for the owner whether or not Brain is recomputing it. */
export function inboxReview(job: BrainJob): boolean {
  return job.state === 'review'
}

/** The Brain nav item and the Inbox tab count the same things. */
export function inboxCount(status: BrainStatus | null): number {
  return status ? status.jobs.filter(inboxReview).length + status.tidy.open : 0
}

/**
 * The open suggestion while a reload no longer brings it back. The page is newest first, so a
 * sweep that adds suggestions pushes the oldest open ones off it: absence alone is not "gone".
 * It is gone once every open suggestion of its kind is loaded without it, or once its own
 * detail said it was settled (`settled`).
 */
export function heldSuggestion(
  page: BrainTidyPage | null,
  seen: BrainTidySuggestion | null,
  selected: string | null,
  settled: string | null,
): BrainTidySuggestion | null {
  if (!page || !seen || selected !== `suggestion:${seen.id}` || settled === selected) return null
  const loaded = page.items.filter((item) => item.state === 'open' && item.kind === seen.kind)
  if (loaded.some((item) => item.id === seen.id)) return null
  return loaded.length < page.counts[seen.kind] ? seen : null
}

/** `held` (see heldSuggestion) stays last in its kind: it is older than every loaded row. */
export function inboxGroups(
  jobs: BrainJob[],
  page: BrainTidyPage | null,
  held: BrainTidySuggestion | null = null,
): InboxGroup[] {
  const reviews = jobs
    .filter(inboxReview)
    .toSorted((a, b) => a.queuedAt - b.queuedAt)
    .map((job): InboxItem => ({ key: `review:${job.id}`, kind: 'review', job }))
  const loaded = (page?.items ?? []).filter((item) => item.state === 'open')
  const suggestions =
    held && !loaded.some((item) => item.id === held.id) ? [...loaded, held] : loaded
  return INBOX_GROUPS.map((id) => {
    const items =
      id === 'lanes'
        ? reviews
        : suggestions
            .filter((item) => item.kind === id)
            .map((suggestion): InboxItem => ({
              key: `suggestion:${suggestion.id}`,
              kind: 'suggestion',
              suggestion,
            }))
    const total = id === 'lanes' ? items.length : Math.max(items.length, page?.counts[id] ?? 0)
    return { id, label: INBOX_GROUP_LABELS[id], items, total }
  }).filter((group) => group.items.length > 0)
}

export function inboxOrder(groups: InboxGroup[]): InboxItem[] {
  return groups.flatMap((group) => group.items)
}

/**
 * Keep the selection while it exists. When it goes (approved, applied, settled elsewhere),
 * take the item that followed it before, else the one before it, else the first.
 */
export function keepInboxSelection(
  previous: readonly string[],
  items: readonly InboxItem[],
  selected: string | null,
): string | null {
  const keys = new Set(items.map((item) => item.key))
  if (selected && keys.has(selected)) return selected
  const at = selected ? previous.indexOf(selected) : -1
  if (at >= 0) {
    const after = previous.slice(at + 1).find((key) => keys.has(key))
    if (after) return after
    const before = previous
      .slice(0, at)
      .toReversed()
      .find((key) => keys.has(key))
    if (before) return before
  }
  return items[0]?.key ?? null
}

export function moveInboxSelection(
  items: readonly InboxItem[],
  selected: string | null,
  delta: 1 | -1,
): string | null {
  if (!items.length) return null
  const at = items.findIndex((item) => item.key === selected)
  if (at < 0) return items[0]!.key
  return items[Math.max(0, Math.min(items.length - 1, at + delta))]!.key
}

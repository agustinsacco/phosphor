import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { GhPrKey, GhPrSummary } from '@shared/models'
import {
  PR_DETAIL_WATCH_MS,
  prDetailOf,
  usePrDetailStore,
  type PrDetailEntry,
} from '@/stores/prDetail'
import { usePrSeenStore, type PrSeenEntry } from '@/stores/prSeen'
import { usePrStatusStore } from '@/stores/prStatus'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { isSummary } from '../prVerdict'
import { laneStatusRefs, type LanePr, type LanePrs } from '../lanePrs'

/** Viewing a PR this long counts as having looked at it. */
export const PR_SEEN_AFTER_MS = 2_000

export interface InspectorFocus {
  key?: GhPrKey
  /** Changes on every request, so asking for the same PR twice still selects it. */
  at: number
}

export interface PrInspectorModel {
  /** Every PR the list shows, in list order. */
  items: LanePr[]
  selected: LanePr | undefined
  select: (key: GhPrKey) => void
  detail: PrDetailEntry
  /** What the PR looked like when you last looked, captured as you selected it. */
  baseline: PrSeenEntry | undefined
}

export function inspectorItems(prs: LanePrs): LanePr[] {
  return [...prs.owned, ...prs.reviewing, ...prs.mentioned]
}

/**
 * Selection, detail reads and the "seen" baseline for one open inspector.
 * Remote (Host) lanes have no local GitHub reads: they show what the Host's
 * listing says and never ask for detail.
 */
export function usePrInspector(
  prs: LanePrs,
  remote: boolean,
  focus?: InspectorFocus,
): PrInspectorModel {
  const items = useMemo(() => inspectorItems(prs), [prs])
  const [chosen, setChosen] = useState<GhPrKey | undefined>(focus?.key)
  useEffect(() => {
    if (focus?.key) setChosen(focus.key)
  }, [focus?.key, focus?.at])
  const selected = items.find((item) => item.key === chosen) ?? items[0]
  const key = selected?.key
  const ref = remote ? undefined : selected?.ref
  const detail = usePrDetailStore((s) => prDetailOf(s, key))
  const summary = isSummary(selected?.pr) ? selected.pr : undefined
  const open = summary ? summary.state === 'OPEN' || summary.state === 'DRAFT' : true

  // The ref object is rebuilt on every status read; the PR's key is its identity.
  const refNow = useRef(ref)
  refNow.current = ref
  const watched = ref ? key : undefined
  useEffect(() => {
    if (!watched) return
    const load = () => {
      if (refNow.current) void usePrDetailStore.getState().load(refNow.current)
    }
    load()
    if (!open) return
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load()
    }, PR_DETAIL_WATCH_MS)
    return () => clearInterval(timer)
  }, [watched, open])

  const baseline = useSeenBaseline(key, summary)
  return { items, selected, select: setChosen, detail, baseline }
}

/** Capture the old snapshot as the PR is selected; record the new one after a look. */
function useSeenBaseline(key: GhPrKey | undefined, summary: GhPrSummary | undefined) {
  const latest = useRef(summary)
  latest.current = summary
  const [baseline, setBaseline] = useState<{ key?: GhPrKey; entry?: PrSeenEntry }>({})
  if (baseline.key !== key)
    setBaseline({ key, entry: key ? usePrSeenStore.getState().byKey[key] : undefined })
  useEffect(() => {
    if (!key) return
    const start = Date.now()
    const record = () => {
      if (latest.current) usePrSeenStore.getState().record(key, latest.current)
    }
    const timer = setTimeout(record, PR_SEEN_AFTER_MS)
    return () => {
      clearTimeout(timer)
      if (Date.now() - start >= PR_SEEN_AFTER_MS) record()
    }
  }, [key])
  return baseline.key === key ? baseline.entry : undefined
}

/** Refresh forces the lane's listing, every PR's status and the shown PR's detail. */
export function useInspectorRefresh(
  repoPath: string | undefined,
  prs: LanePrs,
  selected: LanePr | undefined,
  remote: boolean,
): () => void {
  return useCallback(() => {
    if (repoPath) void usePullRequestsStore.getState().refresh(repoPath, { force: true })
    if (remote) return
    void usePrStatusStore.getState().refresh(laneStatusRefs(prs, true), { force: true })
    if (selected?.ref) void usePrDetailStore.getState().load(selected.ref, { force: true })
  }, [repoPath, prs, selected, remote])
}

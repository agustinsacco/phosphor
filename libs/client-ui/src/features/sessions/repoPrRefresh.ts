import { useEffect } from 'react'
import { prKey } from '@shared/github-pr-refs'
import type { GhPrRef } from '@shared/models'
import { PR_STALE_MS, repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'
import {
  PR_STATUS_STALE_MS,
  PR_STATUS_WATCH_MS,
  isTerminal,
  usePrStatusStore,
} from '@/stores/prStatus'

// One clock and one listener pair for every mounted PR consumer: repository
// discovery and PR status by number alike. These references express UI
// relevance only; they never own sessions or subprocesses.
const consumers = new Map<string, number>()
interface PrConsumer {
  ref: GhPrRef
  count: number
  /** Mounted by the active lane: read every 30s while its checks run. */
  watched: number
}
const prConsumers = new Map<string, PrConsumer>()
let timer: ReturnType<typeof setTimeout> | undefined
let listening = false

const mounted = () => consumers.size + prConsumers.size

/** How stale a PR may get before the next read. Undefined: never again this run. */
function staleMs(consumer: PrConsumer): number | undefined {
  const entry = usePrStatusStore.getState().byKey[prKey(consumer.ref)]
  if (isTerminal(entry?.summary) || entry?.coverage?.state === 'absent') return undefined
  const checks = entry?.summary?.checks
  return consumer.watched && checks?.pending ? PR_STATUS_WATCH_MS : PR_STATUS_STALE_MS
}

function schedule(): void {
  clearTimeout(timer)
  if (!mounted() || document.hidden) return
  const now = Date.now()
  const state = usePullRequestsStore.getState()
  const status = usePrStatusStore.getState().byKey
  const waits = Array.from(consumers.keys(), (key) => {
    const slice = repoPullRequests(state, key)
    return slice.attemptedAt + PR_STALE_MS - now
  })
  for (const consumer of prConsumers.values()) {
    const stale = staleMs(consumer)
    if (stale !== undefined)
      waits.push((status[prKey(consumer.ref)]?.attemptedAt ?? 0) + stale - now)
  }
  if (waits.length) timer = setTimeout(refreshRelevant, Math.max(1_000, Math.min(...waits)))
}

function refreshRelevant(): void {
  clearTimeout(timer)
  if (document.hidden || !mounted()) return
  // Both stores handle failures themselves and coalesce recent or in-flight reads.
  for (const key of consumers.keys()) void usePullRequestsStore.getState().refresh(key)
  const byCadence = new Map<number, GhPrRef[]>()
  for (const consumer of prConsumers.values()) {
    const stale = staleMs(consumer)
    if (stale !== undefined) byCadence.set(stale, [...(byCadence.get(stale) ?? []), consumer.ref])
  }
  const reads = [...byCadence].map(([stale, refs]) =>
    usePrStatusStore.getState().refresh(refs, { staleMs: stale }),
  )
  // Reschedule from the answers, not from when they were asked for.
  void Promise.allSettled(reads).then(schedule)
  schedule()
}

function visibilityChanged(): void {
  if (document.hidden) clearTimeout(timer)
  else refreshRelevant()
}

function listen(): void {
  if (mounted() && !listening) {
    window.addEventListener('focus', refreshRelevant)
    document.addEventListener('visibilitychange', visibilityChanged)
    listening = true
  } else if (!mounted() && listening) {
    window.removeEventListener('focus', refreshRelevant)
    document.removeEventListener('visibilitychange', visibilityChanged)
    listening = false
  }
}

function retainRepos(keys: string[]): () => void {
  for (const key of keys) consumers.set(key, (consumers.get(key) ?? 0) + 1)
  listen()
  refreshRelevant()
  return () => {
    for (const key of keys) {
      const count = consumers.get(key) ?? 0
      if (count <= 1) consumers.delete(key)
      else consumers.set(key, count - 1)
    }
    listen()
    schedule()
  }
}

function retainPrs(refs: GhPrRef[], watched: boolean): () => void {
  for (const ref of refs) {
    const consumer = prConsumers.get(prKey(ref)) ?? { ref, count: 0, watched: 0 }
    consumer.count++
    if (watched) consumer.watched++
    prConsumers.set(prKey(ref), consumer)
  }
  listen()
  refreshRelevant()
  return () => {
    for (const ref of refs) {
      const consumer = prConsumers.get(prKey(ref))
      if (!consumer) continue
      consumer.count--
      if (watched) consumer.watched--
      if (consumer.count <= 0) prConsumers.delete(prKey(ref))
    }
    listen()
    schedule()
  }
}

/** Register visible repo groups, the Home board, or the active lane's own repo. */
export function useRepoPrRefresh(repoPaths: readonly string[], revision?: unknown): void {
  const keys = JSON.stringify([...new Set(repoPaths.filter(Boolean))].sort())
  useEffect(() => retainRepos(JSON.parse(keys) as string[]), [keys])
  // Summary/disk changes and agent settlement request stale reads, not force.
  useEffect(() => {
    refreshRelevant()
  }, [keys, revision])
}

/**
 * Register PRs to read by number: a visible lane row's, or the active lane's
 * (`watched`), which is read every 30s while its checks run.
 */
export function usePrStatusRefresh(refs: readonly GhPrRef[], watched = false): void {
  const key = JSON.stringify(
    [...new Map(refs.map((ref) => [prKey(ref), ref])).values()].sort((a, b) =>
      prKey(a).localeCompare(prKey(b)),
    ),
  )
  useEffect(() => retainPrs(JSON.parse(key) as GhPrRef[], watched), [key, watched])
}

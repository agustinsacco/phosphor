import { useEffect } from 'react'
import { PR_STALE_MS, repoPullRequests, usePullRequestsStore } from '@/stores/pullRequests'

// One clock and one listener pair for all mounted repository consumers. These
// references express UI relevance only; they never own sessions or subprocesses.
const consumers = new Map<string, number>()
let timer: ReturnType<typeof setTimeout> | undefined
let listening = false

function schedule(): void {
  clearTimeout(timer)
  if (!consumers.size || document.hidden) return
  const now = Date.now()
  const state = usePullRequestsStore.getState()
  const delay = Math.min(
    ...Array.from(consumers.keys(), (key) => {
      const slice = repoPullRequests(state, key)
      return Math.max(1_000, slice.attemptedAt + PR_STALE_MS - now)
    }),
  )
  timer = setTimeout(refreshRelevant, delay)
}

function refreshRelevant(): void {
  clearTimeout(timer)
  if (document.hidden || !consumers.size) return
  // refresh handles failures itself and coalesces recent/in-flight reads.
  for (const key of consumers.keys()) void usePullRequestsStore.getState().refresh(key)
  schedule()
}

function visibilityChanged(): void {
  if (document.hidden) clearTimeout(timer)
  else refreshRelevant()
}

function retainRepos(keys: string[]): () => void {
  for (const key of keys) consumers.set(key, (consumers.get(key) ?? 0) + 1)
  if (consumers.size && !listening) {
    window.addEventListener('focus', refreshRelevant)
    document.addEventListener('visibilitychange', visibilityChanged)
    listening = true
  }
  refreshRelevant()
  return () => {
    for (const key of keys) {
      const count = consumers.get(key) ?? 0
      if (count <= 1) consumers.delete(key)
      else consumers.set(key, count - 1)
    }
    if (!consumers.size && listening) {
      window.removeEventListener('focus', refreshRelevant)
      document.removeEventListener('visibilitychange', visibilityChanged)
      listening = false
    }
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

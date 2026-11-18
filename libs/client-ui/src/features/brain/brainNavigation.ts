import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { BrainStatus } from '@shared/brain'
import { useLayoutStore } from '@/stores/layout'
import { inboxCount } from './inbox/inboxItems'

export type BrainTab = 'inbox' | 'knowledge' | 'lanes'
/** Where a notice, toast or another page asks the Brain page to go. */
export type BrainTarget =
  | { tab: 'inbox'; item?: string }
  | { tab: 'lanes'; recent?: boolean; jobId?: string }
  | { tab: 'knowledge'; search?: boolean }
export const useBrainNavigation = create<{
  /** Counts every openBrain() and never goes back, so each request has its own number. */
  request: number
  target: BrainTarget | null
  /** The tab on screen while the page is open; notices stay quiet about what it shows. */
  tab: BrainTab | null
}>(() => ({ request: 0, target: null, tab: null }))

export function openBrain(target: BrainTarget): void {
  useBrainNavigation.setState((s) => ({ request: s.request + 1, target }))
  useLayoutStore.getState().setPage('brain')
}

/** Open the Inbox on its suggestions, or Lanes on its newest recent change. */
export function openTidy(recent = false): void {
  openBrain(recent ? { tab: 'lanes', recent: true } : { tab: 'inbox' })
}

/** Something to decide opens the Inbox; otherwise knowledge, or the reads that will bring it. */
export function firstBrainTab(status: BrainStatus): BrainTab {
  if (inboxCount(status)) return 'inbox'
  return !status.counts.memories && status.jobs.length ? 'lanes' : 'knowledge'
}

/** The page's tab, and the latest target a notice or another page asked for. */
export function useBrainTab(status: BrainStatus) {
  const [tab, setTab] = useState<BrainTab>(() => firstBrainTab(status))
  const [target, setTarget] = useState<{ value: BrainTarget; request: number } | null>(null)
  const request = useBrainNavigation((s) => s.request)
  useEffect(() => {
    const next = useBrainNavigation.getState().target
    if (!request || !next) return
    setTab(next.tab)
    setTarget({ value: next, request })
    // Only the target is consumed: a page mounted later must not replay it.
    useBrainNavigation.setState({ target: null })
  }, [request])
  useEffect(() => {
    useBrainNavigation.setState({ tab })
    return () => useBrainNavigation.setState({ tab: null })
  }, [tab])
  return { tab, setTab, target }
}

export function inboxIsVisible(): boolean {
  return useLayoutStore.getState().page === 'brain' && useBrainNavigation.getState().tab === 'inbox'
}

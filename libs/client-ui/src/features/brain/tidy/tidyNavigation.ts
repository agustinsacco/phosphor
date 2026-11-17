import { useEffect, useState } from 'react'
import { create } from 'zustand'
import type { BrainStatus } from '@shared/brain'
import { useLayoutStore } from '@/stores/layout'

export type BrainTab = 'knowledge' | 'lanes' | 'tidy'
export const useTidyNavigation = create<{
  request: number
  recent: boolean
  tab: BrainTab
}>(() => ({ request: 0, recent: false, tab: 'knowledge' }))

export function openTidy(recent = false): void {
  useTidyNavigation.setState((s) => ({ request: s.request + 1, recent }))
  useLayoutStore.getState().setPage('brain')
}
export function useBrainTab(status: BrainStatus) {
  const [tab, setTab] = useState<BrainTab>(() =>
    !status.counts.memories && status.jobs.length ? 'lanes' : 'knowledge',
  )
  const [recent, setRecent] = useState(0)
  const request = useTidyNavigation((s) => s.request)
  useEffect(() => {
    if (!request || !status.prefs.enabled) return
    setTab('tidy')
    if (useTidyNavigation.getState().recent) setRecent((value) => value + 1)
    useTidyNavigation.setState({ request: 0 })
  }, [request, status.prefs.enabled])
  useEffect(() => {
    useTidyNavigation.setState({ tab })
    return () => useTidyNavigation.setState({ tab: 'knowledge' })
  }, [tab])
  useEffect(() => {
    if (!status.prefs.enabled && tab === 'tidy') setTab('knowledge')
  }, [status.prefs.enabled, tab])
  return { tab, setTab, recent }
}
export function tidyIsVisible(): boolean {
  return useLayoutStore.getState().page === 'brain' && useTidyNavigation.getState().tab === 'tidy'
}

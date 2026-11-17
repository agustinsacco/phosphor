import { useEffect } from 'react'
import { create } from 'zustand'
import type { BrainLaneRef, BrainPrefs, BrainStatus, BrainReviewDecision } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { usePlatform } from '@/platform/Platform'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { createTidyNotices } from './tidy/tidyNotices'

export const brainToast = (text: string, kind: 'success' | 'error' = 'success'): void => {
  useExtensionUiStore.getState().pushToast(text, kind)
}

interface BrainState {
  status: BrainStatus | null
  error: string
  saving: boolean
  refresh: () => Promise<void>
  setPrefs: (prefs: BrainPrefs) => Promise<boolean>
  download: () => Promise<boolean>
  removeModel: () => Promise<boolean>
  queue: (lane: BrainLaneRef) => Promise<boolean>
  cancel: (id: string) => Promise<boolean>
  review: (id: string, keep: BrainReviewDecision | null, revision: number) => Promise<boolean>
  reread: (id: string) => Promise<boolean>
  retry: (id: string) => Promise<boolean>
  reset: () => Promise<boolean>
  forget: (id: string) => Promise<boolean>
}

function failed(error: unknown): void {
  const text = ipcErrorText(error)
  useBrain.setState({ error: text })
  brainToast(text, 'error')
}

// A poll started before an action must not overwrite that action’s returned status.
let mutationVersion = 0

export async function mutateBrain<T extends BrainStatus>(operation: () => Promise<T>): Promise<T> {
  const version = ++mutationVersion
  useBrain.setState({ saving: true })
  try {
    const status = await operation()
    if (version === mutationVersion)
      useBrain.setState({ status: status.supported ? status : null, error: '' })
    return status
  } finally {
    if (version === mutationVersion) useBrain.setState({ saving: false })
  }
}

async function update(operation: () => Promise<BrainStatus>, toast?: string): Promise<boolean> {
  try {
    await mutateBrain(operation)
    if (toast) brainToast(toast)
    return true
  } catch (error) {
    failed(error)
    return false
  }
}

let refreshing: Promise<void> | null = null
export const useBrain = create<BrainState>(() => ({
  status: null,
  error: '',
  saving: false,
  refresh: () => {
    const version = mutationVersion
    refreshing ??= window.phosphor
      .invoke('brain:status')
      .then((status) => {
        if (version === mutationVersion)
          useBrain.setState({ status: status.supported ? status : null, error: '' })
      })
      .catch((error: unknown) => {
        if (version === mutationVersion) failed(error)
      })
      .finally(() => {
        refreshing = null
      })
    return refreshing
  },
  setPrefs: (prefs) => update(() => window.phosphor.invoke('brain:setPrefs', prefs)),
  download: () => update(() => window.phosphor.invoke('brain:download')),
  removeModel: () => update(() => window.phosphor.invoke('brain:removeModel')),
  queue: (lane) =>
    update(
      () => window.phosphor.invoke('brain:queue', lane),
      `Queued ${lane.title} for knowledge extraction`,
    ),
  cancel: (id) =>
    update(() => window.phosphor.invoke('brain:cancel', id), 'Cancelled knowledge extraction'),
  review: (id, keep, revision) =>
    update(() => window.phosphor.invoke('brain:review', id, keep, revision)),
  reread: (id) => update(() => window.phosphor.invoke('brain:reread', id)),
  retry: (id) => update(() => window.phosphor.invoke('brain:retry', id)),
  reset: () => update(() => window.phosphor.invoke('brain:reset'), 'Brain knowledge reset'),
  forget: (id) => update(() => window.phosphor.invoke('brain:forget', id), 'Memory forgotten'),
}))

export function brainInFlight(status: BrainStatus | null): boolean {
  return (
    !!status &&
    (status.tidy.running ||
      ['downloading', 'verifying', 'testing'].includes(status.embedding.phase) ||
      status.jobs.some((job) => ['waiting', 'queued', 'running'].includes(job.state)))
  )
}

let subscribers = 0
let stop: (() => void) | null = null
function subscribe(): () => void {
  subscribers++
  if (subscribers === 1) {
    let timer: ReturnType<typeof setTimeout> | undefined
    let active = true
    const notice = createTidyNotices()
    notice(useBrain.getState().status)
    const schedule = (): void => {
      clearTimeout(timer)
      if (
        active &&
        document.visibilityState !== 'hidden' &&
        (brainInFlight(useBrain.getState().status) || useBrain.getState().status?.prefs.enabled)
      ) {
        timer = setTimeout(
          () => {
            void useBrain.getState().refresh().then(schedule)
          },
          brainInFlight(useBrain.getState().status) ? 2000 : 10000,
        )
      }
    }
    const visible = (): void => {
      if (document.visibilityState !== 'hidden') void useBrain.getState().refresh()
      schedule()
    }
    const off = useBrain.subscribe((state) => {
      notice(state.status)
      schedule()
    })
    document.addEventListener('visibilitychange', visible)
    stop = () => {
      active = false
      notice(null)
      clearTimeout(timer)
      off()
      document.removeEventListener('visibilitychange', visible)
    }
    void useBrain.getState().refresh()
    schedule()
  }
  return () => {
    if (--subscribers === 0) {
      stop?.()
      stop = null
    }
  }
}

/** One visible-window poller: fast during work, quiet while enabled to discover lane flags. */
export function useBrainSync(ready = true): void {
  const supported = usePlatform().localBrain
  useEffect(() => {
    if (supported && ready) return subscribe()
    return undefined
  }, [supported, ready])
}

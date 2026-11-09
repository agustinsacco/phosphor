import { useEffect } from 'react'
import { create } from 'zustand'
import type { BrainLaneRef, BrainPrefs, BrainStatus } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { usePlatform } from '@/platform/Platform'
import { useExtensionUiStore } from '@/stores/extensionUi'

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
  review: (id: string, keep: number[] | null, revision: number) => Promise<boolean>
  forget: (id: string) => Promise<boolean>
}

function failed(error: unknown): void {
  const text = ipcErrorText(error)
  useBrain.setState({ error: text })
  brainToast(text, 'error')
}

// A poll started before an action must not overwrite that action’s returned status.
let mutationVersion = 0

async function update(operation: () => Promise<BrainStatus>, toast?: string): Promise<boolean> {
  mutationVersion++
  useBrain.setState({ saving: true })
  try {
    const status = await operation()
    useBrain.setState({ status: status.supported ? status : null, error: '' })
    if (toast) brainToast(toast)
    return true
  } catch (error) {
    failed(error)
    return false
  } finally {
    useBrain.setState({ saving: false })
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
  forget: (id) => update(() => window.phosphor.invoke('brain:forget', id), 'Memory forgotten'),
}))

export function brainInFlight(status: BrainStatus | null): boolean {
  return (
    !!status &&
    (['downloading', 'verifying', 'testing'].includes(status.embedding.phase) ||
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
    const schedule = (): void => {
      clearTimeout(timer)
      if (
        active &&
        document.visibilityState !== 'hidden' &&
        brainInFlight(useBrain.getState().status)
      ) {
        timer = setTimeout(() => {
          void useBrain.getState().refresh().then(schedule)
        }, 2000)
      }
    }
    const visible = (): void => {
      if (document.visibilityState !== 'hidden') void useBrain.getState().refresh()
      schedule()
    }
    const off = useBrain.subscribe(schedule)
    document.addEventListener('visibilitychange', visible)
    stop = () => {
      active = false
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

/** Shared consumers own one visible-window poller, only while work is in flight. */
export function useBrainSync(ready = true): void {
  const supported = usePlatform().localBrain
  useEffect(() => {
    if (supported && ready) return subscribe()
    return undefined
  }, [supported, ready])
}

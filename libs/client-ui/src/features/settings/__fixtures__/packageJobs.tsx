import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { vi } from 'vitest'
import { usePackageJob } from '../usePackageJob'

type Listeners<T> = Map<string, Set<(payload: T) => void>>

/**
 * A package job's channels as the renderer sees Electron's: a message for a
 * job nobody listens to yet is dropped, never replayed.
 */
export function packageJobChannels() {
  const output: Listeners<string> = new Map()
  const exit: Listeners<number> = new Map()
  const listen =
    <T,>(listeners: Listeners<T>) =>
    (jobId: string, listener: (payload: T) => void) => {
      const set = listeners.get(jobId) ?? new Set()
      set.add(listener)
      listeners.set(jobId, set)
      return () => void set.delete(listener)
    }
  vi.stubGlobal('phosphor', {
    onPackagesJobOutput: listen(output),
    onPackagesJobExit: listen(exit),
  })
  return {
    send: (jobId: string, text: string) => output.get(jobId)?.forEach((fn) => fn(text)),
    exit: (jobId: string, code: number) => exit.get(jobId)?.forEach((fn) => fn(code)),
    listening: () => [...output.values(), ...exit.values()].reduce((n, set) => n + set.size, 0),
  }
}

/** Mounts `usePackageJob` and hands back its latest return value. */
export async function renderPackageJob() {
  const onExit = vi.fn()
  let job: ReturnType<typeof usePackageJob> | undefined
  function Probe(): null {
    job = usePackageJob(onExit)
    return null
  }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  return {
    onExit,
    job: () => {
      if (!job) throw new Error('usePackageJob did not render')
      return job
    },
    unmount: () => act(() => root.unmount()),
  }
}

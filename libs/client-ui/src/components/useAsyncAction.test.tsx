// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useAsyncAction, type AsyncAction } from './useAsyncAction'

let root: Root | null = null
let container: HTMLDivElement | null = null

/** Render a probe and hand back the live hook value. */
function mount(onError?: (message: string) => void): () => AsyncAction {
  let latest: AsyncAction | null = null
  function Probe(): null {
    latest = useAsyncAction(onError)
    return null
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<Probe />))
  return () => latest!
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
})

describe('useAsyncAction', () => {
  it('starts idle', () => {
    const action = mount()
    expect(action().busy).toBe(false)
    expect(action().error).toBeNull()
  })

  it('is busy while the action runs and idle again after', async () => {
    const action = mount()
    let release = (): void => {}
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })

    let running: Promise<void>
    act(() => {
      running = action().run(() => pending)
    })
    expect(action().busy).toBe(true)

    await act(async () => {
      release()
      await running
    })
    expect(action().busy).toBe(false)
    expect(action().error).toBeNull()
  })

  it('captures a thrown message and clears it on the next run', async () => {
    const action = mount()
    await act(async () => {
      await action().run(() => Promise.reject(new Error('boom')))
    })
    expect(action().error).toBe('boom')
    expect(action().busy).toBe(false)

    await act(async () => {
      await action().run(() => Promise.resolve())
    })
    expect(action().error).toBeNull()
  })

  it('normalizes a non-Error rejection instead of casting it', async () => {
    const action = mount()
    await act(async () => {
      await action().run(() => Promise.reject('plain string'))
    })
    expect(action().error).toBe('plain string')
  })

  it('reports thrown failures to onError but not ones set directly', async () => {
    const onError = vi.fn()
    const action = mount(onError)
    await act(async () => {
      await action().run(() => Promise.reject(new Error('thrown')))
    })
    expect(onError).toHaveBeenCalledWith('thrown')

    act(() => action().setError('returned a reason'))
    expect(action().error).toBe('returned a reason')
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

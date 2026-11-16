import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserAttention } from './attention'

const event = {
  id: 'one',
  laneId: 'lane',
  kind: 'needs-input' as const,
  title: 'Fix build',
  at: '2026-01-01T00:00:00Z',
  attention: 1,
}
afterEach(() => vi.unstubAllGlobals())
it('publishes the in-app Host notice and sends the shared machine-titled native payload', async () => {
  const postMessage = vi.fn()
  vi.stubGlobal('Notification', { permission: 'granted' })
  vi.stubGlobal('navigator', {
    serviceWorker: { getRegistration: async () => ({ active: { postMessage } }) },
  })
  const publish = vi.fn()
  const attention = createBrowserAttention({
    connection: () => undefined,
    label: () => 'bee1',
    publish,
    generation: () => 1,
  })
  attention.receive('host', event)
  expect(publish).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: 'host', laneId: 'lane', kind: 'needs-input' }),
  )
  await vi.waitFor(() =>
    expect(postMessage).toHaveBeenCalledWith({
      type: 'phosphor-attention',
      notice: {
        title: 'bee1 · Fix build',
        body: 'needs-input',
        route: { hostId: 'host', laneId: 'lane' },
      },
    }),
  )
  attention.clear()
})
it('drops native delivery waiting for a worker across an owner change or disposal', async () => {
  for (const next of [2, undefined]) {
    const postMessage = vi.fn()
    let resolve!: (value: unknown) => void
    vi.stubGlobal('Notification', { permission: 'granted' })
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: () =>
          new Promise((done) => {
            resolve = done
          }),
      },
    })
    let epoch: number | undefined = 1
    const attention = createBrowserAttention({
      connection: () => undefined,
      label: () => 'bee1',
      publish: vi.fn(),
      generation: () => epoch,
    })
    attention.receive('host', event)
    epoch = next
    attention.clear()
    resolve({ active: { postMessage } })
    await Promise.resolve()
    expect(postMessage).not.toHaveBeenCalled()
  }
})

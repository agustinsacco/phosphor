// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TrafficEntry, TrafficPage } from '@shared/ipc'
import { useMachinesStore } from '@/stores/machines'
import { MACHINE } from './__fixtures__/control'
import { formatTrafficLine, TRAFFIC_POLL_MS, TrafficLogPanel } from './TrafficLogPanel'

const entry = (seq: number, patch: Partial<TrafficEntry> = {}): TrafficEntry => ({
  seq,
  at: Date.UTC(2026, 9, 17, 12, 0, seq),
  peer: 'host',
  hostId: MACHINE.id,
  direction: 'in',
  kind: 'result',
  detail: 'machine.providers',
  bytes: 120,
  ms: 40,
  outcome: 'ok',
  ...patch,
})
let pages: TrafficPage[]
const invoke = vi.fn(async (_channel: string, after: number): Promise<TrafficPage> => {
  return pages.shift() ?? { entries: [], last: after, gap: false }
})
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  invoke.mockClear()
  pages = []
  useMachinesStore.setState({ machines: [MACHINE] })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const rows = (): string[] =>
  [...container.querySelectorAll('tbody tr')].map((row) => row.textContent ?? '')
const button = (text: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent === text)
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}
const tick = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(TRAFFIC_POLL_MS)
  })
}

it('tails from the last cursor, names Hosts by label and hides pings until asked', async () => {
  pages = [
    {
      entries: [
        entry(1, { kind: 'ping', direction: 'out', outcome: undefined }),
        entry(2),
        entry(3, { outcome: 'error', code: 'timeout', detail: 'machine.claude' }),
      ],
      last: 3,
      gap: false,
    },
    {
      entries: [
        entry(4, {
          peer: 'control',
          hostId: undefined,
          direction: 'call',
          kind: 'GET /v1/machines',
        }),
      ],
      last: 4,
      gap: false,
    },
  ]
  await act(async () => root.render(<TrafficLogPanel onClose={() => {}} />))
  expect(invoke).toHaveBeenLastCalledWith('hosts:traffic', 0)
  expect(rows()).toHaveLength(2)
  expect(rows()[0]).toContain('bee1')
  expect(container.textContent).toContain('2 of 3 · 1 error')
  await tick()
  expect(invoke).toHaveBeenLastCalledWith('hosts:traffic', 3)
  expect(rows().at(-1)).toContain('control')
  await act(async () => button('Pings').click())
  expect(rows()).toHaveLength(4)
  await act(async () => button('Errors').click())
  expect(rows()).toHaveLength(1)
  expect(rows()[0]).toContain('timeout')
})

it('pauses polling, says when lines were dropped and clears only the view', async () => {
  pages = [{ entries: [entry(9)], last: 9, gap: true }]
  await act(async () => root.render(<TrafficLogPanel onClose={() => {}} />))
  expect(container.textContent).toContain('Older lines were dropped')
  await act(async () => button('Pause').click())
  const calls = invoke.mock.calls.length
  await tick()
  await tick()
  expect(invoke.mock.calls.length).toBe(calls)
  expect(container.querySelector('[role=status]')?.textContent).toBe('Paused')
  await act(async () => button('Clear').click())
  expect(rows()).toHaveLength(0)
  expect(container.textContent).toContain('Waiting for traffic')
  await act(async () => button('Resume').click())
  // Resumes from where it stopped, not from the beginning.
  expect(invoke).toHaveBeenLastCalledWith('hosts:traffic', 9)
})

it('says so when main stops answering', async () => {
  invoke.mockRejectedValueOnce(new Error('gone'))
  await act(async () => root.render(<TrafficLogPanel onClose={() => {}} />))
  expect(container.querySelector('[role=status]')?.textContent).toBe('Not updating')
  await tick()
  expect(container.querySelector('[role=status]')?.textContent).toBe('Live')
})

it('copies one tab-separated line per entry with UTC milliseconds', () => {
  expect(formatTrafficLine(entry(3, { outcome: 'error', code: 'timeout' }), 'bee1')).toBe(
    ['12:00:03.000', 'bee1', 'in', 'result', 'machine.providers', '120 B', '40 ms', 'timeout'].join(
      '\t',
    ),
  )
})

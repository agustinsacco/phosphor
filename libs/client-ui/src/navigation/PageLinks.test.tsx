// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBrain } from '@/features/brain/useBrain'
import { mockBrainStatus } from '@/features/brain/mockBrainData'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { PageLinks } from './PageLinks'

let container: HTMLDivElement
let root: Root
const onPage = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const status = mockBrainStatus()
  useBrain.setState({ status })
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => useBrain.getState().status) })
  container = document.createElement('div')
  root = createRoot(container)
  onPage.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('puts Archive below Machines and enabled Brain after Archive', async () => {
  useBrain.setState({
    status: {
      ...mockBrainStatus(),
      prefs: {
        neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
        enabled: true,
        recall: true,
        agentAuto: true,
        model: null,
      },
    },
  })
  await act(async () => root.render(<PageLinks activePage="brain" onPage={onPage} />))
  const buttons = [...container.querySelectorAll('button')]
  const machines = buttons.findIndex((b) => b.textContent === 'Machines')
  expect(buttons[machines + 1]!.textContent).toBe('Archive')
  expect(buttons[machines + 2]!.textContent).toBe('Brain')
  expect(buttons[machines + 2]!.querySelector('.leading-5')).not.toBeNull()
  await act(async () => buttons[machines + 2]!.click())
  expect(onPage).toHaveBeenCalledWith('brain')
})

it('hides Brain while off and reacts to enabling without hiding other pages', async () => {
  await act(async () => root.render(<PageLinks onPage={onPage} />))
  expect(container.textContent).not.toContain('Brain')
  expect(container.textContent).toContain('Machines')
  act(() =>
    useBrain.setState({
      status: {
        ...mockBrainStatus(),
        prefs: {
          neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
          enabled: true,
          recall: true,
          agentAuto: true,
          model: null,
        },
      },
    }),
  )
  expect(container.textContent).toContain('Brain')
})

it('does not load or offer local Brain on a browser platform', async () => {
  useBrain.setState({
    status: {
      ...mockBrainStatus(),
      prefs: {
        neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
        enabled: true,
        recall: true,
        agentAuto: true,
        model: null,
      },
    },
  })
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <PageLinks onPage={onPage} />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).not.toContain('Brain')
  expect(window.phosphor.invoke).not.toHaveBeenCalled()
})

it('counts what waits for Brain Agent at the right edge and removes the count live at zero', async () => {
  const { mockBrainJob } = await import('@/features/brain/mockBrainData')
  const status = {
    ...mockBrainStatus(),
    prefs: {
      enabled: true,
      recall: true,
      agentAuto: true,
      model: null,
      neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
    },
    jobs: [
      mockBrainJob(),
      mockBrainJob({ id: 'ledger' }),
      mockBrainJob({ id: 'running', state: 'running' }),
    ],
  }
  status.agent.waiting.unlinked = 2
  useBrain.setState({ status })
  await act(async () => root.render(<PageLinks onPage={onPage} />))
  const count = container.querySelector('[aria-label="2 waiting"]')!
  expect(count.textContent).toBe('2')
  expect(count.className).toContain('ml-auto')
  await act(async () =>
    useBrain.setState({
      status: {
        ...status,
        jobs: [],
        agent: { ...status.agent, waiting: { ...status.agent.waiting, unlinked: 0 } },
      },
    }),
  )
  expect(container.querySelector('[aria-label$="waiting"]')).toBeNull()
})

it('counts one waiting unlinked pair', async () => {
  const { mockBrainJob } = await import('@/features/brain/mockBrainData')
  useBrain.setState({
    status: {
      ...mockBrainStatus(),
      prefs: {
        neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
        enabled: true,
        recall: true,
        agentAuto: true,
        model: null,
      },
      jobs: [mockBrainJob()],
      agent: {
        ...mockBrainStatus().agent,
        waiting: { entities: 0, groups: 0, unlinked: 1, repeats: 0, conflicts: 0, flags: 0 },
      },
    },
  })
  await act(async () => root.render(<PageLinks onPage={onPage} />))
  expect(container.querySelector('[aria-label="1 waiting"]')).not.toBeNull()
})

it('counts the whole Defrag queue, not the read queue', async () => {
  const { mockBrainJob } = await import('@/features/brain/mockBrainData')
  const base = mockBrainStatus()
  useBrain.setState({
    status: {
      ...base,
      prefs: {
        neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
        enabled: true,
        recall: true,
        agentAuto: true,
        model: null,
      },
      jobs: [
        mockBrainJob(),
        mockBrainJob({ id: 'failed', state: 'failed' }),
        mockBrainJob({ id: 'queued', state: 'queued' }),
      ],
      agent: {
        ...base.agent,
        waiting: { entities: 1, groups: 1, unlinked: 1, repeats: 1, conflicts: 0, flags: 1 },
      },
    },
  })
  await act(async () => root.render(<PageLinks onPage={onPage} />))
  expect(container.querySelector('[aria-label="5 waiting"]')?.textContent).toBe('5')
})

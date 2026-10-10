// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { BackgroundWorkIndicator } from './BackgroundWorkIndicator'
import fixture from './__fixtures__/subagent-workflow.json'

vi.mock('./SubagentPanel', () => ({
  SubagentPanel: ({ sessionId, onClose }: { sessionId: string; onClose: () => void }) => (
    <div role="dialog" data-session={sessionId}>
      <button onClick={onClose}>Close</button>
    </div>
  ),
}))

let root: Root
let el: HTMLDivElement
let snapshot: typeof fixture.snapshot
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  useChatStore.setState({ sessions: {} })
  useChatStore.getState().ensure('lane')
  useExtensionUiStore.setState({ widgets: {} })
  snapshot = structuredClone(fixture.snapshot)
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})

function publish(payload: unknown = snapshot, sessionId = 'lane'): void {
  act(() =>
    useExtensionUiStore.setState({
      widgets: {
        [sessionId]: {
          'subagent-async': {
            placement: 'aboveEditor',
            lines: [`PI_SUBAGENT_ASYNC_JSON:${JSON.stringify(payload)}`],
          },
        },
      },
    }),
  )
}
function render(): void {
  act(() => root.render(<BackgroundWorkIndicator sessionId="lane" />))
}
const strip = (): Element | null => el.querySelector('[data-testid="background-work-indicator"]')

it('keeps an idle parent visibly working through its active, named steps, not finished siblings', () => {
  publish()
  render()
  expect(strip()?.textContent).toContain('Working in the background')
  expect(strip()?.textContent).toContain(
    'validation: running · needs parent attention; qa: running',
  )
  expect(strip()?.textContent).not.toContain('reviewer')
  expect(strip()?.textContent).toContain('The parent is idle. You can still message it.')
  expect(strip()?.textContent).toContain('Attention signals are for the parent.')
  expect(el.querySelector('.phosphor-loader')?.getAttribute('data-animated')).toBe('true')
  expect(strip()?.textContent).not.toMatch(/tokens|seconds|accept|approval/)
})

it.each(['streaming', 'booting', 'compacting'])(
  'does not add a second beacon while the parent is %s',
  (state) => {
    useChatStore.setState({
      sessions: {
        lane: {
          ...useChatStore.getState().sessions.lane!,
          isStreaming: state === 'streaming',
          isCompacting: state === 'compacting',
          promptSentAt: state === 'booting' ? 1 : null,
        },
      },
    })
    publish()
    render()
    expect(strip()).not.toBeNull()
    expect(strip()?.textContent).toContain('Messages still go to the parent, not a child.')
    expect(el.querySelector('.phosphor-loader')).toBeNull()
  },
)

it('shows active descendants even after their enclosing root settles and preserves queued state', () => {
  snapshot.runs[0]!.state = 'complete'
  snapshot.runs[0]!.children[1]!.state = 'queued'
  publish()
  render()
  expect(strip()?.textContent).toContain('validation: queued')
  expect(strip()?.textContent).toContain('qa: running')
})

it.each(['complete', 'failed', 'partial', 'paused', 'stopped', 'rejected'])(
  'removes activity when all nodes are %s, without calling it success',
  (state) => {
    publish()
    render()
    snapshot.runs[0]!.state = state
    snapshot.runs[0]!.children.forEach((child) => {
      child.state = state
    })
    publish()
    expect(strip()).toBeNull()
  },
)

it('qualifies incomplete snapshots rather than inventing active work or a completed outcome', () => {
  snapshot.runs = []
  snapshot.omitted.runs = 1
  publish()
  render()
  expect(strip()?.textContent).toContain('Background status incomplete')
  expect(strip()?.textContent).toContain('some work may not be shown')
  expect(el.querySelector('.phosphor-loader')?.getAttribute('data-animated')).toBe('false')
})

it('stays absent for missing, foreign-lane and unsupported snapshots', () => {
  render()
  expect(strip()).toBeNull()
  publish(snapshot, 'other-lane')
  expect(strip()).toBeNull()
  publish({ ...snapshot, version: 2 })
  expect(strip()).toBeNull()
})

it('opens this lane inspection and keeps it open when the extension removes the widget', () => {
  publish()
  render()
  act(() => el.querySelector('button')!.click())
  expect(el.querySelector('[role="dialog"]')?.getAttribute('data-session')).toBe('lane')
  act(() => useExtensionUiStore.setState({ widgets: {} }))
  expect(strip()).toBeNull()
  expect(el.querySelector('[role="dialog"]')).not.toBeNull()
  act(() =>
    el
      .querySelector('[role="dialog"] button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  expect(el.querySelector('[role="dialog"]')).toBeNull()
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useSessionsStore } from '@/stores/sessions'
import type { McpLaneResult } from '@shared/mcp-inspection'
import { LaneConnectorStatus } from './LaneConnectorStatus'

let root: Root | undefined
let container: HTMLDivElement
let restore: (() => void) | undefined
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  restore?.()
  useSessionsStore.setState({ activeSessionId: null, live: {} })
  vi.useRealTimers()
})

async function renderLane(answer: McpLaneResult) {
  vi.useFakeTimers()
  const laneControl = vi.fn(() => Promise.resolve(answer))
  restore = installFakePhosphor(createFakePhosphor({ 'mcp:laneControl': laneControl }))
  useSessionsStore.setState({
    activeSessionId: 'lane',
    live: { lane: { phosphorId: 'lane', workspacePath: '/workspace' } },
  } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root!.render(<LaneConnectorStatus workspacePath="/workspace" name="x" />))
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  return laneControl
}

it('hides lane controls and stops asking when the lane’s pi cannot inspect', async () => {
  const laneControl = await renderLane({
    ok: false,
    unsupported: true,
    message: 'Old pi.',
  } as never)
  expect(container.textContent).not.toContain('Selected lane')
  expect(laneControl).toHaveBeenCalledTimes(1)
})

it('keeps polling a lane whose pi supports inspection', async () => {
  const laneControl = await renderLane({
    ok: true,
    inspectedAt: 0,
    report: { name: 'x', state: 'connected', tools: [] },
  })
  expect(container.textContent).toContain('Selected lane · connected · 0 tools')
  expect(laneControl.mock.calls.length).toBeGreaterThan(1)
})

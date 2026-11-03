// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { GettingStartedScreen } from './GettingStartedScreen'

const invoke = vi.fn(async (channel: string): Promise<unknown> => {
  if (channel === 'packages:list') return []
  if (channel === 'packages:detect') return { claude: false }
  if (channel === 'packages:checkUpdates') return {}
  return undefined
})
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', {
    invoke,
    platform: 'darwin',
    onPackagesJobOutput: () => () => {},
    onPackagesJobExit: () => () => {},
  })
  invoke.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it('lists the recommendations without asking the registry for versions (regression R-M9)', async () => {
  await act(async () => root.render(<GettingStartedScreen onDone={() => {}} />))
  const channels = invoke.mock.calls.map(([channel]) => channel)
  expect(channels).toContain('packages:list')
  expect(channels).not.toContain('packages:checkUpdates')
})

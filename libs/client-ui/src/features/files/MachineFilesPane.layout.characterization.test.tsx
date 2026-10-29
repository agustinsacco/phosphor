// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { COMPACT_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { MachineFilesPane } from './MachineFilesPane'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: ({ value }: { value: string }) => <pre>{value}</pre>,
}))
const repositoryId = '1234567890abcdef'
const invoke = vi.fn(async (channel: string) =>
  channel === 'hosts:repositoryFiles'
    ? ['README.md']
    : { binary: false, content: 'Remote preview' },
)
let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, { phosphor: { invoke } })
  invoke.mockClear()
  useRemoteLanesStore.setState({
    hosts: {
      host: {
        connectionToken: 'test',
        state: 'ready',
        capabilities: ['workspaces.read'],
        repositories: [{ id: repositoryId, name: 'Remote repo', path: '/not-used' }],
        lanes: [],
      },
    },
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/* A phone shows the file list or one file, with a way back; a wider client shows both. */
it.each([
  ['phone', COMPACT_PLATFORM, true],
  ['wide browser', WIDE_BROWSER_PLATFORM, false],
] as const)('lays out the files for a %s', async (_name, platform, stacked) => {
  await act(async () =>
    root.render(
      <PlatformProvider value={platform}>
        <MachineFilesPane hostId="host" />
      </PlatformProvider>,
    ),
  )
  const select = container.querySelector('select')!
  await act(async () => {
    select.value = repositoryId
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  const list = () => container.querySelector('nav[aria-label="Repository files"]')
  const back = () =>
    [...container.querySelectorAll('button')].find((b) => b.textContent === '← Files')
  await act(async () => list()!.querySelector('button')!.click())
  expect(container.textContent).toContain('Remote preview')
  expect(list() === null).toBe(stacked)
  expect(back() !== undefined).toBe(stacked)
  if (stacked) {
    await act(async () => back()!.click())
    expect(list()).not.toBeNull()
  }
})

// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ArtifactsPane } from './ArtifactsPane'
import { useArtifactsStore } from '@/stores/artifacts'
import { useChatStore } from '@/stores/chat'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('@/features/files/MonacoEditor', () => ({ MonacoDiff: () => null }))
vi.mock('@/components/markdown/MermaidBlock', () => ({ MermaidBlock: () => null }))
vi.mock('@/components/markdown/ChartBlock', () => ({ ChartBlock: () => null }))

const invoke = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke })
  invoke.mockReset()
  useArtifactsStore.setState({ bySession: {}, selected: {}, selectedVersion: {} })
  useArtifactsStore.getState().ingest('lane', 'artifact_create', {
    id: 'field-guide',
    title: 'Field guide',
    type: 'markdown',
    content: 'Guide',
    version: 1,
  })
  useChatStore.getState().ensure('lane')
})
afterEach(() => {
  vi.unstubAllGlobals()
  useChatStore.getState().remove('lane')
})

async function clickSaveSource(): Promise<void> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => root.render(<ArtifactsPane sessionId="lane" workspacePath="/repo" />))
  const save = container.querySelector<HTMLButtonElement>('[data-tooltip="Save source to file…"]')
  expect(save).not.toBeNull()
  await act(async () => save?.click())
  act(() => root.unmount())
  container.remove()
}

it('Desktop: Save source asks where, writes the shown version and reveals it', async () => {
  invoke.mockImplementation(async (channel: string) =>
    channel === 'app:saveDialog' ? '/out/field-guide.md' : undefined,
  )
  await clickSaveSource()
  expect(invoke.mock.calls.filter(([channel]) => channel !== 'artifacts:forSession')).toEqual([
    [
      'app:saveDialog',
      expect.objectContaining({ title: 'Save artifact', defaultPath: 'field-guide.md' }),
    ],
    ['fs:writeFile', '/out/field-guide.md', 'Guide'],
    ['app:revealPath', '/out/field-guide.md'],
  ])
})

it('Desktop: a cancelled Save source writes nothing', async () => {
  invoke.mockResolvedValue(null)
  await clickSaveSource()
  expect(invoke.mock.calls.map(([channel]) => channel)).not.toContain('fs:writeFile')
})

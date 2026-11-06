// @vitest-environment jsdom
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostCapability } from '@shared/remote-host'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { renderRemoteFilesPane } from './__fixtures__/renderRemoteFilesPane'

vi.mock('@/lib/monaco', () => ({}))
vi.mock('./MonacoEditor', () => ({
  releaseFileModel: vi.fn(),
  MonacoEditor: () => null,
  MonacoDiff: () => null,
}))

const ACTIONS = ['New file', 'New folder', 'Rename', 'Trash', 'Copy to folder', 'Move to folder']

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

async function renderToolbar(capabilities: HostCapability[]): Promise<HTMLDivElement> {
  const pane = await renderRemoteFilesPane({
    capabilities,
    controller: true,
    phosphor: {
      invoke: vi.fn(async (channel: string) => (channel === 'fs:listFiles' ? ['a.ts'] : {})),
    },
  })
  root = pane.root
  return pane.container
}

it('gives every file action its own icon', async () => {
  const container = await renderToolbar([
    'sessions.read',
    'sessions.control',
    'workspaces.read',
    'workspaces.write',
  ])
  const icons = ACTIONS.map(
    (label) => container.querySelector(`button[aria-label="${label}"] svg`)?.outerHTML,
  )
  expect(icons.every(Boolean)).toBe(true)
  expect(new Set(icons).size).toBe(ACTIONS.length)
})

it('marks a lane without write access with a read-only tag', async () => {
  const container = await renderToolbar(['sessions.read', 'workspaces.read'])
  const tag = [...container.querySelectorAll('span')].find((s) => s.textContent === 'Read only')
  expect(tag).toBeDefined()
  // The settings SourceBadge's chip, in its secondary colours.
  for (const name of [
    'rounded-full',
    'px-1.5',
    'text-2xs',
    'bg-bg-secondary',
    'text-text-secondary',
  ])
    expect(tag!.classList).toContain(name)
  for (const label of ACTIONS)
    expect(container.querySelector(`button[aria-label="${label}"]`)).toBeNull()
})

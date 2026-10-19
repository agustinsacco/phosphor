// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { CompactNew } from '@/shell/compact/CompactNew'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachineCataloguesStore, machineCatalogueKey } from '@/stores/machineCatalogues'
import { useDraftsStore, homeDraftKey, clearDraftMemory } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useRemoteModelPicks } from '@/stores/remoteModelPicks'
import { startRemoteChat } from './startRemoteChat'

vi.mock('./startRemoteChat', () => ({ startRemoteChat: vi.fn() }))
const key = homeDraftKey(`host:${MOCK_HOST_ID}/machine`)
let root: Root
let el: HTMLDivElement
let restore: () => void
let fake: ReturnType<typeof createFakePhosphor>
let complete: () => void
let reject: (error: Error) => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  )
  fake = createFakePhosphor({ 'app:setDraft': () => undefined, 'app:clearDraft': () => undefined })
  restore = installFakePhosphor(fake)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('skills.read')
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
  useMachineCataloguesStore.setState({
    catalogues: {
      [machineCatalogueKey(MOCK_HOST_ID)]: {
        status: 'ready',
        error: null,
        models: [{ id: 'm', name: 'Available model', provider: 'p', reasoning: false }],
        providers: [{ id: 'p', name: 'Provider', status: 'ready' }],
      },
    },
  })
  useRemoteModelPicks.setState({ last: {}, thinking: {} })
  useHomeSubmissionsStore.setState({ pending: {} })
  clearDraftMemory()
  useDraftsStore.getState().setText(key, 'Task for this Host')
  vi.mocked(startRemoteChat)
    .mockReset()
    .mockImplementation(async (_host, _input, _text, _files, accepted) => {
      await new Promise<void>((resolve, fail) => {
        complete = resolve
        reject = fail
      })
      accepted()
    })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  clearDraftMemory()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
})
async function render(content: ReactNode = <CompactNew hostId={MOCK_HOST_ID} />): Promise<void> {
  await act(async () =>
    root.render(<PlatformProvider value={COMPACT_PLATFORM}>{content}</PlatformProvider>),
  )
}
async function send(): Promise<void> {
  await act(async () => {
    const button = [...el.querySelectorAll('button')].find(
      (b) =>
        ['Start lane', 'Starting…'].includes(b.textContent ?? '') ||
        b.getAttribute('aria-label') === 'Start lane',
    )!
    button.click()
  })
}
it('submits the Host-scoped draft and guards another send until acceptance', async () => {
  await render()
  expect(el.textContent).toContain('Available model')
  await send()
  expect(startRemoteChat).toHaveBeenCalledWith(
    MOCK_HOST_ID,
    expect.objectContaining({
      repositoryId: '0000000000000001',
      provider: 'p',
      model: 'm',
      thinkingLevel: 'off',
    }),
    'Task for this Host',
    [],
    expect.any(Function),
  )
  await send()
  expect(startRemoteChat).toHaveBeenCalledOnce()
  await act(async () => complete())
  expect(useDraftsStore.getState().drafts[key]).toBeUndefined()
  expect(useHomeSubmissionsStore.getState().pending[key]).toBeUndefined()
})
it('keeps the same focused field while a flaky Host reconnects', async () => {
  await render()
  const field = el.querySelector('textarea')!
  act(() => field.focus())
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  for (const [state, connectionToken] of [
    ['reconnecting', 'attempt-1'],
    ['connecting', 'attempt-2'],
    ['ready', 'attempt-3'],
  ] as const)
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...host, state, connectionToken } },
      }),
    )
  expect(el.querySelector('textarea')).toBe(field)
  expect(document.activeElement).toBe(field)
})
it('keeps the space under the composer to its target row', async () => {
  await render()
  expect(el.textContent).toContain('Available model')
  expect(el.textContent).not.toContain('takes control')
  expect(el.textContent).not.toContain('Using the first available model')
  expect(el.querySelectorAll('.remote-start-note')).toHaveLength(0)
})
it('keeps a newer draft when the old prompt receipt completes after unmount', async () => {
  await render()
  await send()
  await render(<p>Lane open</p>)
  useDraftsStore.getState().setText(key, 'Next task')
  await act(async () => complete())
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('Next task')
  expect(useHomeSubmissionsStore.getState().pending[key]).toBeUndefined()
})
it('keeps the draft and releases the claim after an uncertain receipt', async () => {
  await render()
  await send()
  await act(async () => reject(new Error('disconnected')))
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('Task for this Host')
  expect(useHomeSubmissionsStore.getState().pending[key]).toBeUndefined()
  expect(el.textContent).toContain('The Host could not confirm this.')
})

it('uses the remembered repository shared with the Desktop remote composer', async () => {
  const { rememberRemoteRepository } = await import('./remoteComposer')
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({
    hosts: {
      [MOCK_HOST_ID]: {
        ...host,
        repositories: [...host.repositories, { id: 'second', name: 'Second', path: '/second' }],
      },
    },
  })
  rememberRemoteRepository(MOCK_HOST_ID, 'second')
  await render()
  await send()
  expect(startRemoteChat).toHaveBeenCalledWith(
    MOCK_HOST_ID,
    expect.objectContaining({ repositoryId: 'second' }),
    expect.any(String),
    [],
    expect.any(Function),
  )
  await act(async () => complete())
})

it('does not clear a new owner draft when the retired submission receipt arrives', async () => {
  await render()
  await send()
  await render(<p>Signed out</p>)
  useHomeSubmissionsStore.setState({ pending: {} })
  clearDraftMemory()
  useDraftsStore.getState().setText(key, 'New owner task')
  await act(async () => complete())
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('New owner task')
})

it('sends an image-only browser draft through the shared remote attachment path', async () => {
  useDraftsStore.getState().setText(key, '')
  const attachments = [
    { kind: 'image' as const, name: 'image.png', mimeType: 'image/png', data: 'dGVzdA==' },
  ]
  useDraftsStore.getState().setAttachments(key, attachments)
  await render()
  expect(el.querySelector('img')?.getAttribute('alt')).toBeTruthy()
  expect(startRemoteChat).not.toHaveBeenCalled()
  await send()
  expect(startRemoteChat).toHaveBeenCalledWith(
    MOCK_HOST_ID,
    expect.any(Object),
    '',
    attachments,
    expect.any(Function),
  )
  await act(async () => complete())
})

it('refuses unsupported browser file drafts before creating a lane', async () => {
  useDraftsStore
    .getState()
    .setAttachments(key, [{ kind: 'file', name: 'notes.txt', path: '', size: 4, data: 'dGVzdA==' }])
  await render()
  await send()
  expect(startRemoteChat).not.toHaveBeenCalled()
  expect(el.textContent).toContain('Only images can be attached in this browser')
})

it('does not release a replacement owner submission when an old receipt settles', async () => {
  await render()
  await send()
  await render(<p>Signed out</p>)
  useHomeSubmissionsStore.setState({ pending: {} })
  clearDraftMemory()
  useDraftsStore.getState().setText(key, 'New owner task')
  useHomeSubmissionsStore.getState().begin(key)
  await act(async () => complete())
  expect(useHomeSubmissionsStore.getState().pending[key]).toBe(true)
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('New owner task')
})

it('does not show a previous Host failure or its draft in a new Host composer', async () => {
  const other = 'other-host'
  const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host, [other]: structuredClone(host) } })
  const catalogue =
    useMachineCataloguesStore.getState().catalogues[machineCatalogueKey(MOCK_HOST_ID)]!
  useMachineCataloguesStore.setState((s) => ({
    catalogues: { ...s.catalogues, [machineCatalogueKey(other)]: catalogue },
  }))
  await render()
  await send()
  await render(<CompactNew hostId={other} />)
  expect(el.querySelector('textarea')?.value).toBe('')
  await act(async () => reject(new Error('late failure')))
  expect(el.textContent).not.toContain('The Host could not confirm this.')
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('Task for this Host')
})

it('validates remembered repository IDs before using a removed repository', async () => {
  const { rememberRemoteRepository } = await import('./remoteComposer')
  rememberRemoteRepository(MOCK_HOST_ID, 'removed')
  await render()
  await send()
  expect(startRemoteChat).toHaveBeenCalledWith(
    MOCK_HOST_ID,
    expect.objectContaining({ repositoryId: '0000000000000001' }),
    expect.any(String),
    [],
    expect.any(Function),
  )
  await act(async () => complete())
})

it('exposes an owner cleanup for repository targets, model and thinking memory', async () => {
  const { clearRemoteStartMemory, useRemoteComposer } = await import('./remoteComposer')
  useRemoteComposer.setState({
    target: { hostId: MOCK_HOST_ID, repositoryId: 'private' },
    repositories: { [MOCK_HOST_ID]: 'private' },
  })
  useRemoteModelPicks.setState({
    last: { [MOCK_HOST_ID]: { provider: 'p', id: 'private' } },
    thinking: { [MOCK_HOST_ID]: 'high' },
  })
  clearRemoteStartMemory()
  expect(useRemoteComposer.getState().target).toBeNull()
  expect(useRemoteComposer.getState().repositories).toEqual({})
  expect(useRemoteModelPicks.getState().last).toEqual({})
  expect(useRemoteModelPicks.getState().thinking).toEqual({})
})

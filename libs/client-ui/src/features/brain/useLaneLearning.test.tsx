// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useLaneLearning } from './useLaneLearning'
import { useLearningUi } from './learningUi'
import { LearningConsent } from './LearningConsent'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { laneActions } from '@/features/sessions/laneActions'
import { PlatformProvider, DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { learningJob, learningPreview } from './__fixtures__/learning'

let root: Root, container: HTMLDivElement, undo: () => void, dispose: () => void
const preview = vi.fn()
function Menu({
  workspace = '/plain-folder',
  path = '/plain-folder/lane.jsonl',
  busy = false,
}: {
  workspace?: string
  path?: string
  busy?: boolean
}): React.JSX.Element {
  const learning = useLaneLearning(workspace, path, 'live', busy)
  const items = laneActions(
    {
      pinned: false,
      markers: 'off',
      pr: null,
      unseen: false,
      running: true,
      busy: false,
      refusals: {},
      learning: learning.learning,
    },
    { learn: learning.learn },
  )
  return (
    <>
      {items.map((item) => (
        <button key={item.label} disabled={item.disabled} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </>
  )
}
async function mount(browser = false, props = {}): Promise<void> {
  await act(async () =>
    root.render(
      <PlatformProvider value={browser ? WIDE_BROWSER_PLATFORM : DESKTOP_PLATFORM}>
        <Menu {...props} />
      </PlatformProvider>,
    ),
  )
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useLearningUi.setState({
    enabled: true,
    workspaces: ['/plain-folder'],
    policyEpoch: 2,
    target: null,
    jobs: [],
  })
  useRemoteLanesStore.setState({ filter: 'local' })
  useSessionsStore.setState({ live: {}, opening: null, deletingSessionKeys: [], bulkDelete: null })
  useChatStore.setState({ sessions: {} })
  preview.mockReset().mockResolvedValue(learningPreview)
  const fake = createFakePhosphor({ 'brain:learnPreview': preview })
  undo = installFakePhosphor(fake)
  dispose = fake.dispose
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  undo()
  dispose()
  container.remove()
  vi.unstubAllGlobals()
})
it('offers a persisted enrolled non-Git source with no manual processor and opens consent only', async () => {
  await mount()
  await act(async () => container.querySelector('button')!.click())
  expect(useLearningUi.getState().target).toEqual({
    workspacePath: '/plain-folder',
    sessionPath: '/plain-folder/lane.jsonl',
  })
  expect(preview).not.toHaveBeenCalled()
})
it('requires a local capability, actual local source, and enrollment rather than machine-blind paths', async () => {
  await mount(true)
  expect(container.querySelector('button')).toBeNull()
  await mount()
  await act(async () =>
    useSessionsStore.setState({
      live: {
        live: {
          phosphorId: 'live',
          workspacePath: '/plain-folder',
          diskPath: '/plain-folder/lane.jsonl',
          target: { kind: 'remote', hostId: 'host' },
        },
      },
    }),
  )
  expect(container.querySelector('button')).toBeNull()
  await act(async () => useSessionsStore.setState({ live: {} }))
  await act(async () => useLearningUi.setState({ workspaces: [] }))
  expect(container.querySelector('button')).toBeNull()
})
it('disables unready and known busy sources; private learners never get ordinary learn actions', async () => {
  await mount(false, { path: '' })
  expect(container.querySelector('button')?.disabled).toBe(true)
  await mount(false, { busy: true })
  expect(container.querySelector('button')?.disabled).toBe(true)
  const job = learningJob({ sessionPath: '/plain-folder/lane.jsonl' })
  await act(async () => useLearningUi.setState({ jobs: [job] }))
  expect(container.querySelector('button')).toBeNull()
})
it('invalidates preflight and consent if the source starts streaming, then loads again when idle', async () => {
  const path = learningPreview.target.sessionPath
  useSessionsStore.setState({
    live: { live: { phosphorId: 'live', workspacePath: '/synthetic', diskPath: path } },
  })
  useChatStore.getState().ensure('live')
  await act(async () =>
    root.render(
      <PlatformProvider value={DESKTOP_PLATFORM}>
        <LearningConsent target={learningPreview.target} />
      </PlatformProvider>,
    ),
  )
  expect(preview).toHaveBeenCalledTimes(1)
  await act(async () =>
    (document.querySelector('input[type=checkbox]') as HTMLInputElement).click(),
  )
  const idle = useChatStore.getState().sessions.live!
  await act(async () =>
    useChatStore.setState({ sessions: { live: { ...idle, isStreaming: true } } }),
  )
  expect(document.querySelector('input[type=checkbox]')).toBeNull()
  expect(document.body.textContent).toContain('Source is busy')
  expect(preview).toHaveBeenCalledTimes(1)
  await act(async () => useChatStore.setState({ sessions: { live: idle } }))
  expect(preview).toHaveBeenCalledTimes(2)
  expect((document.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(false)
})

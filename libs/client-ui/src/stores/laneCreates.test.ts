import { beforeEach, expect, it, vi } from 'vitest'
import type { LiveSessionInfo } from '@shared/models'
import type { HostLaneView } from '@shared/ipc'
import { hostResourceKey } from '@shared/remote-host'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { submitRemoteHome } from '@/features/home/submitRemoteHome'
import { startRemoteChat, type LaneCreateHooks } from '@/features/home/startRemoteChat'
import { homeDraftKey, useDraftsStore, clearDraftMemory } from './drafts'
import { useSessionsStore } from './sessions'
import { useLayoutStore } from './layout'
import { useRemoteLanesStore } from './remoteLanes'
import { useExtensionUiStore } from './extensionUi'
import {
  dismissLaneCreate,
  editLaneCreate,
  pendingLaneCreates,
  reconcileLaneCreate,
  useLaneCreatesStore,
} from './laneCreates'

vi.mock('@/lib/monaco', () => ({}))
vi.mock('@/features/home/startRemoteChat', () => ({ startRemoteChat: vi.fn() }))
vi.mock('./hostsSnapshotRead', async (original) => ({
  ...(await original<object>()),
  refreshHostsSnapshot: vi.fn(async () => {}),
}))

const REPO = '0000000000000001'
const key = homeDraftKey(`host:${MOCK_HOST_ID}/machine`)
/** Each background create, held until the test settles it. */
let runs: {
  text: string
  hooks: LaneCreateHooks
  resolve: () => void
  reject: (error: Error) => void
}[] = []

beforeEach(() => {
  runs = []
  vi.mocked(startRemoteChat)
    .mockReset()
    .mockImplementation(
      (_host, _input, text, _files, _accepted, _swarm, hooks) =>
        new Promise<void>((resolve, reject) => {
          runs.push({ text, hooks: hooks ?? {}, resolve, reject })
        }),
    )
  vi.stubGlobal('window', { phosphor: { invoke: vi.fn(async () => undefined) } })
  clearDraftMemory()
  useLaneCreatesStore.setState({ creates: {} })
  useSessionsStore.setState({
    live: { mac: { phosphorId: 'mac', workspacePath: '/mac' } },
    activeSessionId: 'mac',
    navSeq: 0,
    opening: null,
  })
  useLayoutStore.setState({ page: 'skills' })
  useExtensionUiStore.setState({ toasts: [] })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: MOCK_HOST_ID })
})

function submit(text: string, branch = true): void {
  useDraftsStore.getState().setText(key, text)
  void submitRemoteHome({
    hostId: MOCK_HOST_ID,
    draftKey: key,
    input: { repositoryId: REPO, provider: 'p', model: 'm' },
    branch,
    text,
    attachments: [],
  })
}

const creates = () => Object.values(useLaneCreatesStore.getState().creates)
const shownCreate = () => useSessionsStore.getState().opening?.create

/** The Host adopts the new lane: it is live here and its id is known. */
function created(run: (typeof runs)[number], laneId: string, sessionId: string): void {
  const info: LiveSessionInfo = { ...mockRemoteInfo, sessionId, laneId }
  useSessionsStore.setState((s) => ({
    live: {
      ...s.live,
      [sessionId]: {
        phosphorId: sessionId,
        workspacePath: info.workspacePath,
        target: { kind: 'remote', hostId: MOCK_HOST_ID },
        laneId,
      },
    },
  }))
  run.hooks.created?.(info)
}

function addSnapshotLane(laneId: string | string[], branch: string | null): void {
  const host = structuredClone(useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!)
  const ids = Array.isArray(laneId) ? laneId : [laneId]
  const added = ids.map((id): HostLaneView => ({
    ...host.lanes[0]!,
    laneId: id,
    repositoryId: REPO,
    branch,
  }))
  host.lanes = [...host.lanes, ...added]
  useRemoteLanesStore.setState({
    hosts: { ...useRemoteLanesStore.getState().hosts, [MOCK_HOST_ID]: host },
  })
}

it('shows the placeholder lane at once, switches to it and clears the composer', () => {
  submit('Fix the login bug')
  // Same tick as Enter: nothing waits on the Host.
  expect(creates()).toHaveLength(1)
  const [create] = creates()
  expect(create).toMatchObject({
    hostId: MOCK_HOST_ID,
    repositoryId: REPO,
    title: 'Fix the login bug',
    text: 'Fix the login bug',
  })
  expect(shownCreate()).toBe(create!.id)
  expect(useLayoutStore.getState().page).toBeNull()
  expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
  expect(
    pendingLaneCreates(useLaneCreatesStore.getState().creates, MOCK_HOST_ID, REPO),
  ).toHaveLength(1)
  // The adopt never takes the screen; the create activates its lane itself.
  expect(runs[0]!.hooks.nav).toBe(-1)
})

it('runs two creates at once, each with its own placeholder', () => {
  submit('First lane')
  submit('Second lane')
  expect(runs).toHaveLength(2)
  const list = pendingLaneCreates(useLaneCreatesStore.getState().creates, MOCK_HOST_ID, REPO)
  expect(list.map((c) => c.title)).toEqual(['Second lane', 'First lane'])
  expect(shownCreate()).toBe(list[0]!.id)
})

it('lands quietly when the user has moved on, and still drops its placeholder', async () => {
  submit('Background lane')
  useSessionsStore.getState().claimNav()
  created(runs[0]!, 'lane-new', 'session-new')
  runs[0]!.resolve()
  await vi.waitFor(() => expect(creates()).toHaveLength(0))
  expect(useSessionsStore.getState().activeSessionId).toBe('mac')
})

it('becomes the real lane in place when the user is still on it', async () => {
  submit('Swap in place')
  created(runs[0]!, 'lane-new', 'session-new')
  // The snapshot shows the lane: its placeholder row gives way to the real row.
  addSnapshotLane('lane-new', 'phosphor/swap-in-place')
  expect(
    pendingLaneCreates(useLaneCreatesStore.getState().creates, MOCK_HOST_ID, REPO),
  ).toHaveLength(0)
  expect(shownCreate()).toBeDefined()
  runs[0]!.resolve()
  await vi.waitFor(() => expect(useSessionsStore.getState().activeSessionId).toBe('session-new'))
  expect(useSessionsStore.getState().opening).toBeNull()
  expect(creates()).toHaveLength(0)
})

it('keeps a definite failure on the placeholder; Edit and retry restores the draft', async () => {
  submit('Will fail')
  const id = creates()[0]!.id
  runs[0]!.reject(new Error('lane-limit'))
  await vi.waitFor(() => expect(creates()[0]?.failure).toMatch(/lane limit/))
  expect(creates()[0]?.unknown).toBeFalsy()
  expect(shownCreate()).toBe(id)
  editLaneCreate(id)
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('Will fail')
  expect(creates()).toHaveLength(0)
  expect(shownCreate()).toBeUndefined()
})

it('dismiss drops the placeholder and leaves the draft empty', async () => {
  submit('Dismiss me')
  const id = creates()[0]!.id
  runs[0]!.reject(new Error('lane-limit'))
  await vi.waitFor(() => expect(creates()[0]?.failure).toBeDefined())
  dismissLaneCreate(id)
  expect(creates()).toHaveLength(0)
  expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
})

it('an unknown receipt finds the lane by its branch instead of creating a duplicate', async () => {
  submit('Maybe made it')
  const id = creates()[0]!.id
  runs[0]!.hooks.trying?.('phosphor/maybe-made-it')
  runs[0]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates()[0]?.unknown).toBe(true))
  expect(creates()[0]?.failure).toMatch(/Check the lane before retrying/)
  addSnapshotLane('lane-found', 'phosphor/maybe-made-it')
  await vi.waitFor(() => expect(creates()).toHaveLength(0))
  // The text goes to the lane that exists, never to a fresh create.
  const laneDraft = hostResourceKey(
    { kind: 'remote', hostId: MOCK_HOST_ID },
    'session',
    'lane-found',
  )
  expect(useDraftsStore.getState().drafts[laneDraft]?.text).toBe('Maybe made it')
  expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
  expect(startRemoteChat).toHaveBeenCalledOnce()
  expect(reconcileLaneCreate(id)).toBeUndefined()
})

it('an unbranched unknown receipt reconciles only with exactly one unseen lane', async () => {
  submit('No branch', false)
  const id = creates()[0]!.id
  runs[0]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates()[0]?.unknown).toBe(true))
  // Two new lanes in the folder at once: which is this one is unknowable.
  addSnapshotLane(['lane-a', 'lane-b'], null)
  expect(reconcileLaneCreate(id)).toBeUndefined()
  expect(creates()).toHaveLength(1)
  // Ambiguous: the draft goes back to Home, still warned.
  editLaneCreate(id)
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('No branch')
})

it('a failure after the lane exists keeps no placeholder and files the text on that lane', async () => {
  submit('Prompt refused')
  created(runs[0]!, 'lane-made', 'session-made')
  runs[0]!.reject(new Error('swarm-failed'))
  await vi.waitFor(() => expect(creates()).toHaveLength(0))
  const laneDraft = hostResourceKey(
    { kind: 'remote', hostId: MOCK_HOST_ID },
    'session',
    'lane-made',
  )
  expect(useDraftsStore.getState().drafts[laneDraft]?.text).toBe('Prompt refused')
  expect(useSessionsStore.getState().activeSessionId).toBe('session-made')
})

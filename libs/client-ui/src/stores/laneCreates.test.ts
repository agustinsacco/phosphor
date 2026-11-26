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
import { useMachinesStore } from './machines'
import { refreshHostsSnapshot } from './hostsSnapshotRead'
import {
  clearLaneCreates,
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
  useMachinesStore.setState({ remoteEnabled: true })
  useExtensionUiStore.setState({ toasts: [] })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: MOCK_HOST_ID })
})

function submit(text: string, branch = true): void {
  useDraftsStore.getState().setText(key, text)
  send(branch)
}

/** Enter: the composer's draft is read from the store, never from a render. */
function send(branch = true): void {
  void submitRemoteHome({
    hostId: MOCK_HOST_ID,
    draftKey: key,
    input: { repositoryId: REPO, provider: 'p', model: 'm' },
    branch,
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
  // Still checking with the Host: nothing to edit yet, and no second create.
  editLaneCreate(id)
  expect(useDraftsStore.getState().drafts[key]?.text ?? '').toBe('')
  expect(creates()[0]?.checking).toBe(true)
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

it('an unknown create keeps checking with the Host for three minutes and never creates again', async () => {
  vi.useFakeTimers()
  try {
    submit('Slow Host')
    const id = creates()[0]!.id
    runs[0]!.hooks.trying?.('phosphor/slow-host')
    runs[0]!.reject(new Error('timeout'))
    await vi.advanceTimersByTimeAsync(0)
    expect(creates()[0]).toMatchObject({ checking: true })
    expect(creates()[0]?.failure).toBeUndefined()
    vi.mocked(refreshHostsSnapshot).mockClear()
    await vi.advanceTimersByTimeAsync(10_000)
    // A fresh snapshot read, not the cached one.
    expect(refreshHostsSnapshot).toHaveBeenCalled()
    editLaneCreate(id)
    expect(creates()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(180_000)
    expect(creates()[0]?.checking).toBeFalsy()
    expect(creates()[0]?.failure).toMatch(/If the lane shows up later, it was created/)
    editLaneCreate(id)
    expect(useDraftsStore.getState().drafts[key]?.text).toBe('Slow Host')
    expect(startRemoteChat).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})

it('an unknown create that the Host lists while checking is adopted', async () => {
  submit('Listed late')
  runs[0]!.hooks.trying?.('phosphor/listed-late')
  runs[0]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates()[0]?.checking).toBe(true))
  addSnapshotLane('lane-late', 'phosphor/listed-late')
  await vi.waitFor(() => expect(creates()).toHaveLength(0))
  const laneDraft = hostResourceKey(
    { kind: 'remote', hostId: MOCK_HOST_ID },
    'session',
    'lane-late',
  )
  expect(useDraftsStore.getState().drafts[laneDraft]?.text).toBe('Listed late')
})

it('never matches a branch the Host refused as already existing', async () => {
  submit('Taken name')
  runs[0]!.hooks.trying?.('phosphor/taken-name')
  runs[0]!.hooks.refused?.('phosphor/taken-name')
  runs[0]!.hooks.trying?.('phosphor/taken-name-2')
  runs[0]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates()[0]?.checking).toBe(true))
  // Someone else's lane on the refused name is not this create's.
  addSnapshotLane('lane-other', 'phosphor/taken-name')
  expect(creates()).toHaveLength(1)
})

it('two unresolved unbranched creates never claim the one new lane', async () => {
  submit('First', false)
  submit('Second', false)
  runs[0]!.reject(new Error('timeout'))
  runs[1]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates().every((c) => c.checking)).toBe(true))
  addSnapshotLane('lane-one', null)
  expect(creates()).toHaveLength(2)
})

it('a lane another create made is never claimed by an unknown unbranched create', async () => {
  submit('Unknown', false)
  submit('Made', false)
  created(runs[1]!, 'lane-made', 'session-made')
  runs[1]!.resolve()
  await vi.waitFor(() => expect(creates()).toHaveLength(1))
  runs[0]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates()[0]?.checking).toBe(true))
  addSnapshotLane('lane-made', null)
  expect(creates()).toHaveLength(1)
})

it('Edit and retry appends to a newer draft instead of replacing it', async () => {
  submit('Failed A')
  const id = creates()[0]!.id
  runs[0]!.reject(new Error('lane-limit'))
  await vi.waitFor(() => expect(creates()[0]?.failure).toBeDefined())
  useDraftsStore.getState().setText(key, 'Draft B')
  editLaneCreate(id)
  expect(useDraftsStore.getState().drafts[key]?.text).toBe('Draft B\n\nFailed A')
})

it('a failed first prompt appends to what was typed on the new lane', async () => {
  submit('Prompt lost')
  created(runs[0]!, 'lane-x', 'session-x')
  const laneDraft = hostResourceKey({ kind: 'remote', hostId: MOCK_HOST_ID }, 'session', 'lane-x')
  useDraftsStore.getState().setText(laneDraft, 'Typed meanwhile')
  runs[0]!.reject(new Error('timeout'))
  await vi.waitFor(() => expect(creates()).toHaveLength(0))
  expect(useDraftsStore.getState().drafts[laneDraft]?.text).toBe('Typed meanwhile\n\nPrompt lost')
})

it('restored images drop the blob ids the cleared draft unlinked', async () => {
  useDraftsStore.getState().patch(key, {
    text: 'With image',
    attachments: [
      { kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'AAAA', blobId: 'b1' },
    ],
  })
  send()
  const id = creates()[0]!.id
  runs[0]!.reject(new Error('lane-limit'))
  await vi.waitFor(() => expect(creates()[0]?.failure).toBeDefined())
  editLaneCreate(id)
  const [image] = useDraftsStore.getState().drafts[key]!.attachments
  expect(image).toMatchObject({ kind: 'image', name: 'a.png' })
  expect(image && 'blobId' in image ? image.blobId : undefined).toBeUndefined()
})

it('reads the draft at Enter: a second Enter in the same tick starts nothing', () => {
  submit('Once')
  send()
  expect(runs).toHaveLength(1)
})

it('the Host listing the lane hides the placeholder row before adoption finishes', () => {
  submit('Listed first')
  // The create resolved; the adopt is still loading the transcript.
  runs[0]!.hooks.created?.({ ...mockRemoteInfo, sessionId: 'session-new', laneId: 'lane-new' })
  addSnapshotLane('lane-new', 'phosphor/listed-first')
  expect(
    pendingLaneCreates(useLaneCreatesStore.getState().creates, MOCK_HOST_ID, REPO),
  ).toHaveLength(0)
})

it('a page opened over the placeholder keeps the page when the lane lands', async () => {
  submit('Behind a page')
  useLayoutStore.getState().setPage('skills')
  created(runs[0]!, 'lane-new', 'session-new')
  runs[0]!.resolve()
  await vi.waitFor(() => expect(creates()).toHaveLength(0))
  expect(useLayoutStore.getState().page).toBe('skills')
  expect(useSessionsStore.getState().activeSessionId).toBe('mac')
  expect(useSessionsStore.getState().opening).toBeNull()
})

it('drops every create on sign-out and on an owner reset', async () => {
  submit('Signed out')
  useMachinesStore.setState({ remoteEnabled: false })
  expect(creates()).toHaveLength(0)
  expect(shownCreate()).toBeUndefined()
  useMachinesStore.setState({ remoteEnabled: true })
  submit('Reset')
  clearLaneCreates()
  expect(creates()).toHaveLength(0)
  expect(shownCreate()).toBeUndefined()
})

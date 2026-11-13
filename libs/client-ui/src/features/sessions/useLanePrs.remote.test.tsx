// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@shared/github-pr-refs'
import type { HostsSnapshot } from '@shared/ipc'
import type { LanePrSignals } from '@shared/models'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { usePrStatusStore } from '@/stores/prStatus'
import { usePrDetailStore } from '@/stores/prDetail'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { prSummary } from './__fixtures__/pullRequests'
import { useLanePullRequests } from './useLanePrs'

const SESSION = 'remote-lane'
const MACHINE = `host:${MOCK_HOST_ID}`
const REF = { host: 'github.com', owner: 'acme', repo: 'app', number: 57 }
const SIGNALS: LanePrSignals = {
  opened: [REF],
  branches: [],
  reviewing: [],
  mentioned: [{ ...REF, number: 61 }],
  pinned: [],
  hidden: [],
}

let root: Root
let container: HTMLDivElement
let restore: () => void
let dispose: () => void
const summaries = vi.fn(async (refs: (typeof REF)[]) => ({
  byKey: Object.fromEntries(
    refs.map((ref) => [prKey(ref), prSummary({ ref, number: ref.number })]),
  ),
  coverage: Object.fromEntries(
    refs.map((ref) => [prKey(ref), { state: 'found', checkedAt: 1, attemptedAt: 1 }]),
  ),
}))
const detail = vi.fn(async () => null)

function hosts(prStatus: boolean, signals?: LanePrSignals): HostsSnapshot {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.capabilities.push('workspaces.read')
  host.prStatus = prStatus
  host.lanes = host.lanes.map((lane) => ({
    ...lane,
    ...(signals ? { pullRequests: signals } : {}),
  }))
  return { [MOCK_HOST_ID]: host }
}

function Lane({ all }: { all?: boolean }) {
  const { lead, prs } = useLanePullRequests(SESSION, { all })
  return (
    <span data-testid="lead">
      {lead ? `#${lead.number}:${lead.pr?.title ?? ''}` : 'none'}|{prs.mentioned.length}
    </span>
  )
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  useSessionsStore.setState({
    activeSessionId: SESSION,
    live: { [SESSION]: { ...mockRemoteInfo, phosphorId: SESSION } },
    disk: {},
    gitByCwd: {},
  })
  useChatStore.setState({ sessions: {} })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  usePrStatusStore.setState({ byKey: {} })
  usePrDetailStore.setState({ byKey: {} })
  summaries.mockClear()
  detail.mockClear()
  const fake = createFakePhosphor({
    'gh:prsForRepo': async () => ({ byBranch: {}, complete: true }),
    'gh:prSummaries': summaries,
    'gh:prDetail': detail,
  } as never)
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function render(all = false) {
  await act(async () => root.render(<Lane all={all} />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  return container.querySelector('[data-testid="lead"]')?.textContent
}

it("uses a Host lane's own PR signals and reads them by number through its Host", async () => {
  useRemoteLanesStore.setState({ hosts: hosts(true, SIGNALS), filter: 'all' })
  expect(await render(true)).toBe(`#57:${prSummary().title}|1`)
  expect(summaries).toHaveBeenCalledWith([REF, { ...REF, number: 61 }], undefined, MACHINE)
  // The inspector's detail read goes to the same Host without being told.
  await act(async () => usePrDetailStore.getState().load(REF))
  expect(detail).toHaveBeenCalledWith(REF, undefined, MACHINE)
})

it('reads a PR on This Mac again once no Host lane holds it', async () => {
  useRemoteLanesStore.setState({ hosts: hosts(true, SIGNALS), filter: 'all' })
  await render()
  act(() => root.unmount())
  root = createRoot(container)
  await act(async () => usePrDetailStore.getState().load(REF, { force: true }))
  expect(detail).toHaveBeenLastCalledWith(REF, { force: true })
})

it('keeps the checkout branch only, and asks nothing by number, on an older Host', async () => {
  useRemoteLanesStore.setState({ hosts: hosts(false), filter: 'all' })
  expect(await render(true)).toBe('none|0')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(summaries).not.toHaveBeenCalled()
})

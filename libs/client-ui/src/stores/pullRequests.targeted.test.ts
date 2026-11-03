// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useSessionsStore } from './sessions'
import { useRemoteLanesStore } from './remoteLanes'
import { repoPullRequests, usePullRequestsStore } from './pullRequests'
import type { GhRepoPullRequests } from '@shared/models'

const pr = {
  number: 1,
  title: 'Known',
  state: 'OPEN' as const,
  url: 'https://github.com/a/b/pull/1',
}
const read = vi.fn<(...args: unknown[]) => Promise<GhRepoPullRequests | null>>()
let restore: () => void
let dispose: () => void
beforeEach(() => {
  useSessionsStore.setState({ live: {}, gitByCwd: {}, activeSessionId: null })
  useRemoteLanesStore.setState({ hosts: {} })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  read.mockReset()
  const fake = createFakePhosphor({ 'gh:prsForRepo': read })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
})
afterEach(() => {
  restore()
  dispose()
  vi.useRealTimers()
})

it('pages more than 100 interested lanes, bounds each tick, and prioritizes the active branch', async () => {
  vi.useFakeTimers()
  useSessionsStore.setState({
    live: { active: { phosphorId: 'active', workspacePath: '/repo/w120' } },
    activeSessionId: 'active',
    gitByCwd: Object.fromEntries(
      Array.from({ length: 121 }, (_, i) => [
        `/repo/w${i}`,
        {
          isRepo: true,
          mainRepoPath: '/repo',
          branch: `b${i}`,
        },
      ]),
    ),
  })
  read.mockImplementation(async (...args) => {
    const branches = (args[1] as { branches: string[] } | undefined)?.branches ?? []
    return {
      byBranch: Object.fromEntries(branches.map((branch) => [branch, pr])),
      complete: false,
      coverage: Object.fromEntries(
        branches.map((branch) => [
          branch,
          { state: 'found', checkedAt: Date.now(), attemptedAt: Date.now() },
        ]),
      ),
    }
  })
  await usePullRequestsStore.getState().refresh('/repo')
  expect(read).toHaveBeenCalledTimes(4)
  expect((read.mock.calls[0]?.[1] as { branches: string[] }).branches[0]).toBe('b120')
  for (const args of read.mock.calls)
    expect((args[1] as { branches: string[] }).branches.length).toBeLessThanOrEqual(20)
  await vi.advanceTimersByTimeAsync(60_001)
  await usePullRequestsStore.getState().refresh('/repo')
  expect(
    Object.keys(repoPullRequests(usePullRequestsStore.getState(), '/repo').byBranch),
  ).toHaveLength(121)
})

it('merges partial replies, preserves uncovered and failed chips, and deletes only explicit absence', async () => {
  read.mockResolvedValueOnce({
    byBranch: { known: pr, removed: pr, uncovered: pr },
    complete: false,
  })
  await usePullRequestsStore.getState().refresh('/repo')
  const coverage = {
    known: { state: 'unavailable', checkedAt: 10, attemptedAt: 20 },
    removed: { state: 'absent', checkedAt: 20, attemptedAt: 20 },
  }
  read.mockResolvedValueOnce({ byBranch: {}, complete: false, coverage } as GhRepoPullRequests)
  await usePullRequestsStore.getState().refresh('/repo', { force: true })
  const slice = repoPullRequests(usePullRequestsStore.getState(), '/repo')
  expect(slice.byBranch.known).toEqual(pr)
  expect(slice.byBranch.uncovered).toEqual(pr)
  expect(slice.byBranch.removed).toBeUndefined()
  expect(slice).toMatchObject({ coverage })
})

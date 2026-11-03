import { beforeEach, expect, it } from 'vitest'
import { remotePrKey } from '@shared/host-protocol-github'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useSessionsStore } from './sessions'
import { useRemoteLanesStore } from './remoteLanes'
import { pullRequestInterests } from './pullRequestInterests'
import { pullRequestPages } from './pullRequestReads'
import { repoPullRequests, usePullRequestsStore } from './pullRequests'

beforeEach(() => {
  useSessionsStore.setState({ live: {}, activeSessionId: null, gitByCwd: {} })
  useRemoteLanesStore.setState({ hosts: {} })
  usePullRequestsStore.setState({ byRepo: {} })
})

it('isolates remote repository identities and prioritizes the active remote lane among 121 summaries', () => {
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  const lane = host.lanes[0]!
  host.lanes = Array.from({ length: 121 }, (_, i) => ({
    ...lane,
    laneId: `lane${i}`,
    branch: `b${i}`,
  }))
  host.lanes.push({ ...lane, repositoryId: '0000000000000002', branch: 'other-repo' })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({
    activeSessionId: 'remote',
    live: { remote: { phosphorId: 'remote', ...mockRemoteInfo, laneId: 'lane120' } },
    gitByCwd: { '/local': { isRepo: true, branch: 'local-only' } },
  })
  const key = remotePrKey(MOCK_HOST_ID, lane.repositoryId)
  const interests = pullRequestInterests(key)
  expect(interests.branches).toHaveLength(121)
  expect(interests.activeBranch).toBe('b120')
  const slice = repoPullRequests(usePullRequestsStore.getState(), key)
  const first = pullRequestPages(interests, slice)
  expect(first).toHaveLength(4)
  expect(first[0]?.[0]).toBe('b120')
  const second = pullRequestPages(interests, {
    ...slice,
    branchAttemptedAt: Object.fromEntries(first.flat().map((branch) => [branch, 100])),
  })
  expect(new Set([...first.flat(), ...second.flat()]).size).toBe(121)
  expect(pullRequestInterests('/local')).toEqual({
    branches: ['local-only'],
    activeBranch: undefined,
  })
})

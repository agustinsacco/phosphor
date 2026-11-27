import { expect, it } from 'vitest'
import type { HostBrainLaneState, HostBrainStatus } from '@shared/host-brain'
import { mockBrainStatus } from '@/features/brain/mockBrainData'

import { hostLaneBrainContext, hostLaneReadSummary } from './hostLaneBrain'

it('distinguishes shared memories from those replaced on a successful Host reread', () => {
  expect(hostLaneReadSummary({ memories: 9, replaceable: 6 })).toContain(
    '3 shared current memories are kept',
  )
  expect(hostLaneReadSummary({ memories: 9, replaceable: 6 })).toContain(
    '6 unshared current memories stay until the new read is saved',
  )
  expect(hostLaneReadSummary({ memories: 6, replaceable: 6 })).not.toContain(
    'shared current memories are kept',
  )
})

it('uses the selected Host’s lane state even when the other Host has the same job ID', () => {
  const { agent, jobs: _jobs, ...status } = mockBrainStatus()
  const { folder: _folder, ...hostAgent } = agent
  const host: HostBrainStatus = {
    ...status,
    agent: { ...hostAgent, run: null },
    jobs: [],
    prefs: { ...status.prefs, enabled: true, neverRead: { titles: ['Northwind'], sessionIds: [] } },
  }
  const harbor: HostBrainLaneState = {
    excluded: false,
    activeJob: null,
    lastRead: { jobId: 'same-id', memories: 9, replaceable: 6 },
  }
  const ledger: HostBrainLaneState = {
    excluded: true,
    activeJob: { id: 'same-id', state: 'running' },
    lastRead: null,
  }
  expect(hostLaneBrainContext(host, harbor, 'Harbor')).toEqual({
    knowledge: 'new',
    brainExclusion: null,
  })
  expect(hostLaneBrainContext(host, harbor, 'Northwind').brainExclusion).toBe('title')
  expect(hostLaneBrainContext(host, ledger, 'Ledger')).toEqual({
    knowledge: 'cancel',
    brainExclusion: 'lane',
  })
})

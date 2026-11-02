import { expect, it } from 'vitest'
import type { HostConnectionView, LaneStartView } from '@shared/ipc'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import type { StartingChat } from '@/stores/startingChat'
import { startingLabel } from './startingStatus'

const REPO = 'repo-a'
const remote: StartingChat = {
  prompt: 'Fix it',
  phase: 'branching',
  remote: { hostId: MOCK_HOST_ID, repositoryId: REPO, draftKey: 'key' },
}
const host = (
  laneStarts?: LaneStartView[],
  state: HostConnectionView['state'] = 'ready',
): HostConnectionView => ({ ...mockRemoteHosts[MOCK_HOST_ID]!, state, laneStarts })
const at = (phase?: LaneStartView['phase']) => [
  { repositoryId: 'repo-b', branch: null, phase: 'prompting' as const },
  { repositoryId: REPO, branch: 'phosphor/fix-it', ...(phase ? { phase } : {}) },
]

it('names each local step', () => {
  expect(startingLabel({ prompt: 'x', phase: 'branching' }, undefined, '')).toBe('Creating branch…')
  expect(startingLabel({ prompt: 'x', phase: 'starting' }, undefined, '')).toBe('Starting session…')
})

it('names each Host step from its own repository, and the machine it runs on', () => {
  expect(startingLabel(remote, host([]), 'bee2')).toBe('Starting a lane on bee2…')
  expect(startingLabel(remote, host(at()), 'bee2')).toBe('Waiting for bee2…')
  expect(startingLabel(remote, host(at('queued')), 'bee2')).toBe(
    'Waiting for bee2 to finish starting another lane…',
  )
  expect(startingLabel(remote, host(at('branching')), 'bee2')).toBe('Creating branch on bee2…')
  expect(startingLabel(remote, host(at('starting')), 'bee2')).toBe('Starting session on bee2…')
  expect(startingLabel(remote, host(at('prompting')), 'bee2')).toBe('Sending your message…')
})

it('says it is reconnecting rather than showing a step from a link that is down', () => {
  expect(startingLabel(remote, host(at('starting'), 'reconnecting'), 'bee2')).toBe(
    'Reconnecting to bee2…',
  )
  expect(startingLabel(remote, undefined, 'bee2')).toBe('Reconnecting to bee2…')
})

it('covers an opened lane while this client sends its first prompt', () => {
  const covering = { ...remote, remote: { ...remote.remote!, sessionId: 's', laneId: 'l' } }
  expect(startingLabel(covering, host([]), 'bee2')).toBe('Sending your message…')
})

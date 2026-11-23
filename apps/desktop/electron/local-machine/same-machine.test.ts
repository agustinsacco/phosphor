import { afterEach, expect, it } from 'vitest'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { fakeLocalService } from './__fixtures__/local-service'
import {
  MAX_SAME_MACHINE_KEY,
  bindSameMachine,
  resolveSameMachineKey,
  sameMachine,
  sameMachineArgs,
} from './same-machine'

const REPO_ID = '0123456789abcdef'
function service() {
  const fake = fakeLocalService('mac-0001')
  fake.repositories = [{ id: REPO_ID, path: '/Users/u/repo' }]
  fake.lanes = [{ laneId: 'lane-1', cwd: '/Users/u/repo/.phosphor/worktrees/a', activity: 'idle' }]
  return fake
}
const view = () => {
  const fake = service()
  return { hostId: fake.hostId, ...fake.connection.snapshot() }
}

afterEach(() => bindSameMachine(null))

it('resolves this machine’s lane and repository keys, with their rest, to real paths', () => {
  const v = view()
  expect(resolveSameMachineKey('host:mac-0001/lane:lane-1', v)).toBe(
    '/Users/u/repo/.phosphor/worktrees/a',
  )
  expect(resolveSameMachineKey('host:mac-0001/lane:lane-1/src/a.ts', v)).toBe(
    '/Users/u/repo/.phosphor/worktrees/a/src/a.ts',
  )
  expect(resolveSameMachineKey(`host:mac-0001/repo:${REPO_ID}`, v)).toBe('/Users/u/repo')
})

it('refuses another Host, unknown ids, dot segments, other key kinds and oversized keys', () => {
  const v = view()
  for (const key of [
    'host:other/lane:lane-1',
    'host:mac-0001/lane:lane-2',
    `host:mac-0001/repo:${'f'.repeat(16)}`,
    'host:mac-0001/lane:lane-1/../../etc',
    'host:mac-0001/lane:lane-1/./a',
    'host:mac-0001/lane:lane-1/',
    'host:mac-0001/lane:lane-1//a',
    'host:mac-0001/machine',
    'host:mac-0001/lane:lane-1/a\0b',
    '/Users/u/repo',
    `host:mac-0001/lane:lane-1/${'a'.repeat(MAX_SAME_MACHINE_KEY)}`,
  ])
    expect([key, resolveSameMachineKey(key, v)]).toEqual([key, null])
})

it('refuses a projection path that is not absolute', () => {
  const v = { ...view(), lanes: [{ ...view().lanes[0]!, cwd: 'relative' }] }
  expect(resolveSameMachineKey('host:mac-0001/lane:lane-1', v)).toBeNull()
})

it('is unbound until the local slot attaches, and again once it detaches', () => {
  const fake = service()
  expect(sameMachine()).toBeUndefined()
  expect(sameMachineArgs('fs:readFile', ['host:mac-0001/lane:lane-1/a'])).toBeNull()
  bindSameMachine({ hostId: fake.hostId, connection: () => fake.connection })
  expect(sameMachine()?.hostId).toBe('mac-0001')
  expect(sameMachineArgs('fs:readFile', ['host:mac-0001/lane:lane-1/a'])).toEqual([
    '/Users/u/repo/.phosphor/worktrees/a/a',
  ])
  bindSameMachine(null)
  expect(sameMachine()).toBeUndefined()
  expect(sameMachineArgs('fs:readFile', ['host:mac-0001/lane:lane-1/a'])).toBeNull()
})

it('refuses this machine’s keys while its connection is lost or gone', () => {
  const fake = service()
  let connection: typeof fake.connection | undefined = fake.connection
  bindSameMachine({ hostId: fake.hostId, connection: () => connection })
  fake.state = 'reconnecting'
  expect(sameMachine()).toBeUndefined()
  expect(() => sameMachineArgs('fs:readFile', ['host:mac-0001/lane:lane-1/a'])).toThrow(
    REMOTE_UNAVAILABLE,
  )
  fake.state = 'ready'
  connection = undefined
  expect(() => sameMachineArgs('fs:readFile', ['host:mac-0001/lane:lane-1/a'])).toThrow(
    REMOTE_UNAVAILABLE,
  )
})

it('leaves calls naming no key of this machine to today’s routing', () => {
  const fake = service()
  bindSameMachine({ hostId: fake.hostId, connection: () => fake.connection })
  expect(sameMachineArgs('fs:readFile', ['/local/a'])).toBeNull()
  expect(sameMachineArgs('fs:readFile', ['host:other/lane:x/a'])).toBeNull()
  // Only selected positions count: file content naming a key is never read as one.
  expect(sameMachineArgs('fs:writeFile', ['/local/a', 'host:mac-0001/lane:lane-1'])).toBeNull()
})

it('rewrites option fields and key arrays into copies, leaving the caller’s values intact', () => {
  const fake = service()
  bindSameMachine({ hostId: fake.hostId, connection: () => fake.connection })
  const search = {
    searchId: 's',
    query: { text: 'x' },
    workspacePath: `host:mac-0001/repo:${REPO_ID}`,
  }
  const dirs = ['host:mac-0001/lane:lane-1/src', '/local']
  expect(sameMachineArgs('fs:searchWorkspace', [search])).toEqual([
    { ...search, workspacePath: '/Users/u/repo' },
  ])
  expect(sameMachineArgs('fs:statDirs', [dirs])).toEqual([
    ['/Users/u/repo/.phosphor/worktrees/a/src', '/local'],
  ])
  expect(search.workspacePath).toBe(`host:mac-0001/repo:${REPO_ID}`)
  expect(dirs[0]).toBe('host:mac-0001/lane:lane-1/src')
  expect(() => sameMachineArgs('fs:statDirs', [['host:mac-0001/lane:nope']])).toThrow(
    REMOTE_UNAVAILABLE,
  )
})

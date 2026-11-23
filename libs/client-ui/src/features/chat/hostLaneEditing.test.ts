import { beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, MOCK_HOST_ID as hostId } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useDraftsStore } from '@/stores/drafts'
import { remoteLaneKey, remoteLaneResourceKey } from '@shared/remote-host'
import { copyHostLane, editHostEntry, readHostTree, visibleHostLanes } from './hostLaneEditing'

const view = mockRemoteHosts[hostId]!
const source = view.lanes[0]!
const laneId = source.laneId
const dest = { hostId, laneId }
const newId = '00000000-0000-4000-8000-000000000099'
const invoke = vi.fn()
const ok = (data: unknown, next?: string) => ({
  status: 'ok',
  text: '',
  applies: 'now',
  data,
  next,
})
beforeEach(() => {
  invoke.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke } })
  useRemoteLanesStore.setState({ hosts: { [hostId]: { ...view, ops: true, laneEditing: true } } })
})
it('joins every page of the selected machine’s tree', async () => {
  const row = { id: 'a', type: 'message', parentId: null, timestamp: 'now' }
  const data = { sessionId: 'pi', leafId: 'b', entries: [row] }
  invoke
    .mockResolvedValueOnce(ok(data, '1'))
    .mockResolvedValueOnce(ok({ ...data, entries: [{ ...row, id: 'b', parentId: 'a' }] }))
  expect((await readHostTree(dest)).entries.map((e) => e.id)).toEqual(['a', 'b'])
  expect(invoke).toHaveBeenLastCalledWith(
    'ops:run',
    { kind: 'remote', hostId },
    { op: 'lane.tree', args: { ref: laneId }, page: '1' },
  )
})
it('fails closed on an old Host and surfaces refusals without issuing a local edit', async () => {
  invoke.mockResolvedValue({
    status: 'denied',
    code: 'not-controller',
    text: 'Another client is in control.',
  })
  await expect(editHostEntry(dest, 'jump', 'e')).rejects.toThrow('Another client')
  useRemoteLanesStore.setState({ hosts: { [hostId]: view } })
  await expect(editHostEntry(dest, 'label', 'e', 'foo')).rejects.toThrow()
  expect(invoke).toHaveBeenCalledTimes(1)
})
it.each(['fork', 'clone', 'rewind'] as const)(
  'targets the sibling returned by lane.%s, not the source',
  async (kind) => {
    invoke.mockResolvedValue(
      ok({ lane: remoteLaneKey(hostId, newId), prefill: 'full text' }, 'lane.resume ...'),
    )
    expect(await copyHostLane(dest, kind, kind === 'clone' ? undefined : 'e')).toEqual({
      hostId,
      laneId: newId,
    })
    expect(invoke).toHaveBeenCalledExactlyOnceWith(
      'ops:run',
      { kind: 'remote', hostId },
      {
        op: `lane.${kind}`,
        args: {
          ref: laneId,
          ...(kind === 'clone' ? {} : kind === 'rewind' ? { entry: 'e' } : { at: 'e' }),
        },
      },
    )
    if (kind === 'rewind')
      expect(useDraftsStore.getState().get(remoteLaneResourceKey(hostId, newId)).text).toBe(
        'full text',
      )
  },
)
it('folds only recorded stopped predecessors of lanes still present on this Host', () => {
  const old = { ...source, activity: 'stopped' as const }
  const replacement = { ...old, laneId: newId, rewoundFrom: laneId }
  expect(visibleHostLanes([old, replacement])).toEqual([replacement])
  expect(visibleHostLanes([old])).toEqual([old])
  expect(visibleHostLanes([{ ...old, pinned: true }, replacement])).toHaveLength(2)
  expect(visibleHostLanes([{ ...old, activity: 'working' }, replacement])).toHaveLength(2)
})

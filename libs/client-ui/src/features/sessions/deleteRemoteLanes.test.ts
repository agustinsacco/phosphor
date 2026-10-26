import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { deleteRemoteLanes } from './deleteRemoteLanes'

const remove = vi.fn(async () => ({ branchKept: false }))
let restore: () => void
beforeEach(() => {
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  host.capabilities.push('workspaces.write')
  host.lanes[0]!.control.controller = { self: true, label: 'You', connected: true }
  host.lanes[0] = { ...host.lanes[0]!, worktree: true }
  host.lanes.push({
    ...host.lanes[0]!,
    laneId: '00000000-0000-4000-8000-000000000097',
    title: 'Second lane',
  })
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live: {}, bulkDelete: null })
  remove.mockReset().mockResolvedValue({ branchKept: false })
  const fake = createFakePhosphor({ 'hosts:deleteLane': remove })
  vi.stubGlobal('window', {})
  restore = installFakePhosphor(fake)
})
afterEach(() => {
  restore()
  vi.unstubAllGlobals()
})
const lanes = () => useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes
const options = { removeWorktree: true, deleteBranch: true }
it('deletes sequentially, removes a shared worktree only with its last lane, and reports kept branches', async () => {
  remove.mockResolvedValueOnce({ branchKept: true })
  await deleteRemoteLanes(MOCK_HOST_ID, lanes(), options)
  expect(remove.mock.calls).toEqual([
    [MOCK_HOST_ID, lanes()[0]!.laneId, { removeWorktree: false, removeBranch: false }],
    [MOCK_HOST_ID, lanes()[1]!.laneId, { removeWorktree: true, removeBranch: true }],
  ])
  expect(useSessionsStore.getState().bulkDelete).toMatchObject({
    running: false,
    done: 2,
    results: [{ ok: true, error: expect.stringContaining('Branch kept') }, { ok: true }],
  })
})
it('does not remove a worktree whose other lane failed, never retries, and continues the batch', async () => {
  remove.mockRejectedValueOnce(new Error('private host error'))
  await deleteRemoteLanes(MOCK_HOST_ID, lanes(), options)
  expect(remove).toHaveBeenCalledTimes(2)
  expect(remove.mock.calls[1]).toEqual([
    MOCK_HOST_ID,
    lanes()[1]!.laneId,
    { removeWorktree: false, removeBranch: false },
  ])
  expect(useSessionsStore.getState().bulkDelete).toMatchObject({
    running: false,
    done: 2,
    results: [{ ok: false, error: expect.not.stringContaining('private') }, { ok: true }],
  })
})
it('cancels after the current command and refuses a concurrent bulk run', async () => {
  remove.mockImplementationOnce(async () => {
    await deleteRemoteLanes(MOCK_HOST_ID, lanes(), options)
    useSessionsStore.getState().cancelBulkDelete()
    return { branchKept: false }
  })
  await deleteRemoteLanes(MOCK_HOST_ID, lanes(), options)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(useSessionsStore.getState().bulkDelete).toMatchObject({
    cancelled: true,
    done: 1,
    running: false,
  })
})
it('rechecks control and capabilities between lanes without taking over', async () => {
  remove.mockImplementationOnce(async () => {
    useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.capabilities = []
    return { branchKept: false }
  })
  await deleteRemoteLanes(MOCK_HOST_ID, lanes(), options)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(useSessionsStore.getState().bulkDelete?.results.map((r) => r.ok)).toEqual([true, false])
})

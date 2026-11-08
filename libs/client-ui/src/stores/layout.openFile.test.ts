import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { laneFilePath, useFilesStore, workspaceFiles } from './files'
import { openFileInWorkspace, sessionPanes, useLayoutStore } from './layout'
import { useRemoteLanesStore } from './remoteLanes'
import { useSessionsStore } from './sessions'

vi.mock('@/features/files/MonacoEditor', () => ({ releaseFileModel: () => {} }))
const invoke = vi.fn()
const lane = mockRemoteInfo.workspacePath
const id = mockRemoteInfo.sessionId

beforeEach(() => {
  invoke.mockReset().mockResolvedValue({ content: 'host', size: 4, mtimeMs: 1, revision: 'r1' })
  vi.stubGlobal('window', { phosphor: { invoke } })
  useSessionsStore.setState({ live: { [id]: { ...mockRemoteInfo, phosphorId: id } } })
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: mockRemoteHosts[MOCK_HOST_ID]! } })
  useFilesStore.setState({ byWorkspace: {} })
  useLayoutStore.setState({ bySession: {} })
})
afterEach(() => vi.unstubAllGlobals())

it('maps a Host lane path to the lane’s key, and refuses aliases and escapes', () => {
  expect(laneFilePath('/host/worktree', 'host:h/lane:a', '/host/worktree/a.ts')).toBe(
    'host:h/lane:a/a.ts',
  )
  expect(laneFilePath('/host/worktree', 'host:h/lane:a', 'src/a.ts')).toBe('host:h/lane:a/src/a.ts')
  expect(laneFilePath('/host/worktree', 'host:h/lane:a', 'host:h/lane:a/b.ts')).toBe(
    'host:h/lane:a/b.ts',
  )
  for (const path of [
    '/host/main/a.ts',
    '../a.ts',
    'host:h/lane:b/a.ts',
    '/host/worktree-other/a.ts',
    '.git/config',
  ])
    expect(() => laneFilePath('/host/worktree', 'host:h/lane:a', path)).toThrow(
      'Not available on remote lanes yet.',
    )
})

it('opens a Host transcript path in that lane’s Files, read through the lane', async () => {
  await openFileInWorkspace(lane, '/remote/demo/src/a.ts', 3, id)
  expect(invoke).toHaveBeenCalledWith('fs:readFile', `${lane}/src/a.ts`)
  const files = workspaceFiles(useFilesStore.getState(), lane)
  expect(files.activePath).toBe(`${lane}/src/a.ts`)
  expect(files.openFiles[0]).toMatchObject({ revision: 'r1', pendingReveal: { line: 3 } })
  expect(sessionPanes(useLayoutStore.getState(), id).pane).toBe('files')
})

it('never reads a Host transcript path outside the lane or without its session', async () => {
  await expect(openFileInWorkspace(lane, '/etc/passwd', undefined, id)).rejects.toThrow(
    'Not available on remote lanes yet.',
  )
  await expect(openFileInWorkspace(lane, 'a.ts')).rejects.toThrow(
    'Not available on remote lanes yet.',
  )
  expect(invoke).not.toHaveBeenCalled()
  expect(sessionPanes(useLayoutStore.getState(), id).pane).toBeNull()
})

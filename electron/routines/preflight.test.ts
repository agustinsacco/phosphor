import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { folderTaskObstacle } from './preflight'

const h = vi.hoisted(() => ({ list: vi.fn(), gitInfo: vi.fn() }))
vi.mock('../registry', () => ({ registry: { list: h.list } }))
vi.mock('../fs/git-info', () => ({ gitInfo: h.gitInfo }))

let directory: string
beforeEach(() => {
  vi.clearAllMocks()
  // Both call sites resolve before calling, and the live-session match is by
  // exact path — on macOS the raw temp dir is a symlink into /private.
  directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'routine-preflight-')))
  h.list.mockReturnValue([])
  h.gitInfo.mockResolvedValue({ isRepo: true, dirtyCount: 0 })
})
afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('folder task preflight', () => {
  it('clears a clean repository', async () => {
    expect(await folderTaskObstacle(directory, 'code')).toBeNull()
  })

  it('refuses a code task in a dirty tree and names the count', async () => {
    h.gitInfo.mockResolvedValue({ isRepo: true, dirtyCount: 6 })
    expect(await folderTaskObstacle(directory, 'code')).toContain('6 uncommitted changes')
  })

  it('singularises one uncommitted change', async () => {
    h.gitInfo.mockResolvedValue({ isRepo: true, dirtyCount: 1 })
    expect(await folderTaskObstacle(directory, 'code')).toContain('1 uncommitted change (')
  })

  it('lets a report read a dirty tree, which no worktree can show it', async () => {
    h.gitInfo.mockResolvedValue({ isRepo: true, dirtyCount: 6 })
    expect(await folderTaskObstacle(directory, 'report')).toBeNull()
  })

  it('ignores a dirty count outside a repository', async () => {
    h.gitInfo.mockResolvedValue({ isRepo: false, dirtyCount: 3 })
    expect(await folderTaskObstacle(directory, 'code')).toBeNull()
  })

  it('still refuses either intent while a live session owns the folder', async () => {
    h.list.mockReturnValue([{ workspacePath: directory }])
    expect(await folderTaskObstacle(directory, 'code')).toContain('in use')
    expect(await folderTaskObstacle(directory, 'report')).toContain('in use')
  })

  it('checks the live session before spending a git call', async () => {
    h.list.mockReturnValue([{ workspacePath: directory }])
    await folderTaskObstacle(directory, 'code')
    expect(h.gitInfo).not.toHaveBeenCalled()
  })

  it('does not consult git at all for a report', async () => {
    await folderTaskObstacle(directory, 'report')
    expect(h.gitInfo).not.toHaveBeenCalled()
  })
})

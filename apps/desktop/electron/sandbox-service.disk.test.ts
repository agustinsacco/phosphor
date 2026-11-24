import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { claudeProjectDirForCwd, sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { deleteSandbox, renameSandbox } from './sandbox-service'

const owner = vi.hoisted(() => ({ userData: '', trash: vi.fn<(path: string) => Promise<void>>() }))
vi.mock('electron', () => ({
  app: { getPath: () => owner.userData },
  shell: { trashItem: owner.trash },
}))
vi.mock('./archive/state', () => ({ hasArchivedFolder: () => false }))
vi.mock('./registry', () => ({ registry: { list: () => [] } }))
vi.mock('./store', () => ({
  realPathOrNull: () => null,
  repointStoredPaths: vi.fn(),
  getPrefs: () => ({ recentWorkspaces: [] }),
  setRecentWorkspaces: vi.fn(),
}))

it('moves a sandbox and lane history, rewriting only the pi header before trashing both trees', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'phosphor-sandbox-move-')))
  owner.userData = root
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', join(root, 'sessions'))
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'cli'))
  try {
    const from = join(root, 'sandboxes', 'before')
    const to = join(root, 'sandboxes', 'after')
    const lane = join('.phosphor', 'worktrees', 'topic')
    const cwd = join(from, lane)
    const moved = join(to, lane)
    const body = '\n{ "type":"message", "text":"old cwd stays in body" }\n'
    const header = (path: string) =>
      JSON.stringify({
        type: 'session',
        cwd: path,
        parentSession: join(sessionDirForCwd(path), 'parent.jsonl'),
      })
    const file = (path: string) => join(sessionDirForCwd(path), 'lane.jsonl')
    const ledger = (path: string) => join(claudeProjectDirForCwd(path), 'ledger.jsonl')
    for (const dir of [
      cwd,
      sessionDirForCwd(cwd),
      claudeProjectDirForCwd(cwd),
      join(root, 'trash'),
    ])
      await mkdir(dir, { recursive: true })
    await writeFile(file(cwd), header(cwd) + body)
    await writeFile(ledger(cwd), 'CLI bytes\n')
    expect(await renameSandbox(from, 'after')).toEqual({ ok: true, path: to })
    await expect(realpath(from)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(realpath(file(cwd))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(file(moved), 'utf8')).toBe(header(moved) + body)
    expect(await readFile(ledger(moved), 'utf8')).toBe('CLI bytes\n')

    owner.trash.mockImplementation((path) => rename(path, join(root, 'trash', basename(path))))
    expect(await deleteSandbox(to)).toEqual({ ok: true })
    expect(owner.trash.mock.calls.map(([path]) => path).sort()).toEqual(
      [to, sessionDirForCwd(moved), claudeProjectDirForCwd(moved)].sort(),
    )
    expect(
      await readFile(join(root, 'trash', basename(sessionDirForCwd(moved)), 'lane.jsonl'), 'utf8'),
    ).toBe(header(moved) + body)
  } finally {
    vi.unstubAllEnvs()
    await rm(root, { recursive: true, force: true })
  }
})

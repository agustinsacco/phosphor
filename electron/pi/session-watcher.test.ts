import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * The regression this file exists for: a watcher pointed at a session
 * directory that does not exist yet is born dead. chokidar does not poll for a
 * missing watch target — it reports nothing watched and never fires, even once
 * the path appears — and a brand-new worktree is always in exactly that state,
 * because pi has not written its first session file yet. The symptom was a
 * chat whose sidebar row stayed a context-menu-less placeholder (right-click
 * did nothing) until an unrelated re-render happened to re-scan the folder.
 */

const sent: unknown[] = []

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
        },
      },
    ],
  },
}))

let root: string
let workspace: string

beforeEach(async () => {
  sent.length = 0
  root = await mkdtemp(join(tmpdir(), 'phosphor-watch-'))
  // pi-paths reads this at call time, so pointing it at a temp dir keeps the
  // test off the developer's real ~/.pi.
  process.env.PI_CODING_AGENT_SESSION_DIR = join(root, 'sessions')
  workspace = join(root, 'brand-new-worktree')
})

afterEach(async () => {
  const { unwatchAll } = await import('./session-watcher')
  await unwatchAll()
  delete process.env.PI_CODING_AGENT_SESSION_DIR
  await rm(root, { recursive: true, force: true })
})

describe('watchWorkspaceSessions', () => {
  it('creates the session dir so the watcher is not born dead', async () => {
    const { sessionDirForCwd } = await import('./pi-paths')
    const { watchWorkspaceSessions } = await import('./session-watcher')
    const dir = sessionDirForCwd(workspace)
    expect(existsSync(dir)).toBe(false)

    watchWorkspaceSessions(workspace)

    expect(existsSync(dir)).toBe(true)
  })

  it('pushes sessions:changed when pi writes the first session file', async () => {
    const { sessionDirForCwd } = await import('./pi-paths')
    const { watchWorkspaceSessions } = await import('./session-watcher')
    const dir = sessionDirForCwd(workspace)

    watchWorkspaceSessions(workspace)
    // Let chokidar finish its initial scan before the file lands, so this
    // exercises the 'add' path rather than the ignored initial listing.
    await new Promise((resolve) => setTimeout(resolve, 300))

    await writeFile(join(dir, '20260822_abc.jsonl'), '{"type":"session_start"}\n')

    // awaitWriteFinish (250ms) + the notify debounce (300ms), plus slack.
    await vi.waitFor(() => expect(sent.length).toBeGreaterThan(0), {
      timeout: 5000,
      interval: 100,
    })
    expect(sent[0]).toEqual({ channel: 'sessions:changed', payload: { workspacePath: workspace } })
  })
})

describe('watch budget', () => {
  it('keeps the per-directory cap high enough for real workspaces, bounded for dumps', async () => {
    const { MAX_WATCHED_SESSION_FILES } = await import('./session-watcher')
    // One fd per watched FILE (see workspace-watcher.ts). The busiest real
    // session dir here holds 10 files; thousands means something else is
    // writing into pi's session tree and must not take the app down.
    expect(MAX_WATCHED_SESSION_FILES).toBeGreaterThanOrEqual(500)
    expect(MAX_WATCHED_SESSION_FILES).toBeLessThanOrEqual(10_000)
  })
})

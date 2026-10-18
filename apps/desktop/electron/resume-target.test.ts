import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { access } from 'node:fs/promises'

/**
 * Launch-location resolution.
 *
 * The rule under test: prefer the exact session, but only when BOTH it and
 * its workspace still exist. A session file whose folder was deleted must
 * degrade to the workspace, and a deleted workspace must degrade to the
 * picker — never route into a screen that cannot load.
 *
 * Runs the real resolver (app/resume-target.ts, which `app:resumeTarget`
 * calls) against real files, so the probe below is the only stand-in.
 */
import type { AppPrefs } from '@shared/models'
import { resolveResumeTarget as resolve } from './app/resume-target'

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The resolver reads only `path` and `lastOpenedAt` of a recent workspace. */
const resolveResumeTarget = ({
  recentWorkspaces = [],
  ...prefs
}: Partial<Pick<AppPrefs, 'lastSessionPath' | 'lastWorkspacePath'>> & {
  recentWorkspaces?: { path: string; lastOpenedAt: number }[]
}) =>
  resolve(
    { ...prefs, recentWorkspaces: recentWorkspaces.map((ws) => ({ ...ws, name: ws.path })) },
    pathExists,
  )

describe('resume target resolution', () => {
  let workspace: string
  let sessionPath: string

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), 'phosphor-resume-'))
    sessionPath = join(workspace, 'session.jsonl')
    await writeFile(sessionPath, '{"type":"session"}\n')
  })

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true })
  })

  it('resumes the exact session when both paths exist', async () => {
    await expect(
      resolveResumeTarget({ lastSessionPath: sessionPath, lastWorkspacePath: workspace }),
    ).resolves.toEqual({ kind: 'session', sessionPath, workspacePath: workspace })
  })

  it('falls back to the workspace when the session file is gone', async () => {
    await rm(sessionPath)
    await expect(
      resolveResumeTarget({ lastSessionPath: sessionPath, lastWorkspacePath: workspace }),
    ).resolves.toEqual({ kind: 'workspace', workspacePath: workspace })
  })

  it('falls back to the picker when the workspace is gone', async () => {
    await rm(workspace, { recursive: true, force: true })
    await expect(
      resolveResumeTarget({ lastSessionPath: sessionPath, lastWorkspacePath: workspace }),
    ).resolves.toEqual({ kind: 'none' })
  })

  it('lands on the workspace when no session was remembered', async () => {
    await expect(resolveResumeTarget({ lastWorkspacePath: workspace })).resolves.toEqual({
      kind: 'workspace',
      workspacePath: workspace,
    })
  })

  it('lands on the picker on a first run', async () => {
    await expect(resolveResumeTarget({})).resolves.toEqual({ kind: 'none' })
  })

  it('ignores a session path with no workspace recorded', async () => {
    await expect(resolveResumeTarget({ lastSessionPath: sessionPath })).resolves.toEqual({
      kind: 'none',
    })
  })

  it('falls back to the newest recent that still exists', async () => {
    await expect(
      resolveResumeTarget({
        recentWorkspaces: [
          { path: join(workspace, 'deleted'), lastOpenedAt: 30 },
          { path: workspace, lastOpenedAt: 20 },
          { path: join(workspace, 'also-deleted'), lastOpenedAt: 10 },
        ],
      }),
    ).resolves.toEqual({ kind: 'workspace', workspacePath: workspace })
  })

  it('prefers a valid lastWorkspacePath over a newer recent', async () => {
    const newer = await mkdtemp(join(tmpdir(), 'phosphor-resume-newer-'))
    try {
      await expect(
        resolveResumeTarget({
          lastWorkspacePath: workspace,
          recentWorkspaces: [{ path: newer, lastOpenedAt: Date.now() }],
        }),
      ).resolves.toEqual({ kind: 'workspace', workspacePath: workspace })
    } finally {
      await rm(newer, { recursive: true, force: true })
    }
  })

  it('lands on the picker when every recent is gone too', async () => {
    await expect(
      resolveResumeTarget({
        recentWorkspaces: [{ path: join(workspace, 'deleted'), lastOpenedAt: 1 }],
      }),
    ).resolves.toEqual({ kind: 'none' })
  })
})

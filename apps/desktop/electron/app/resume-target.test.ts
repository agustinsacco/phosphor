import { expect, it, vi } from 'vitest'
import type { AppPrefs } from '@shared/models'
import { resolveResumeTarget } from './resume-target'

const prefs = (
  overrides: Partial<AppPrefs> = {},
): Pick<AppPrefs, 'lastSessionPath' | 'lastWorkspacePath' | 'recentWorkspaces'> => ({
  recentWorkspaces: [],
  ...overrides,
})

it('resumes the exact session only when both paths exist', async () => {
  const exists = vi.fn(async () => true)
  expect(
    await resolveResumeTarget(
      prefs({ lastSessionPath: '/session', lastWorkspacePath: '/ws' }),
      exists,
    ),
  ).toEqual({ kind: 'session', sessionPath: '/session', workspacePath: '/ws' })
  expect(exists.mock.calls).toHaveLength(2)
  expect(await resolveResumeTarget(prefs({ lastSessionPath: '/session' }), exists)).toEqual({
    kind: 'none',
  })
})

it('prefers the last workspace to recents when its session is absent', async () => {
  const exists = vi.fn(async (path: string) => path !== '/session')
  expect(
    await resolveResumeTarget(
      prefs({
        lastSessionPath: '/session',
        lastWorkspacePath: '/ws',
        recentWorkspaces: [{ path: '/newer', name: 'newer', lastOpenedAt: 3 }],
      }),
      exists,
    ),
  ).toEqual({ kind: 'workspace', workspacePath: '/ws' })
  expect(exists).not.toHaveBeenCalledWith('/newer')
})

it('does not resume an existing session whose workspace has disappeared', async () => {
  expect(
    await resolveResumeTarget(
      prefs({ lastSessionPath: '/session', lastWorkspacePath: '/gone' }),
      async (path) => path === '/session',
    ),
  ).toEqual({ kind: 'none' })
})

it('selects the newest existing recent without mutating the supplied order', async () => {
  const recentWorkspaces = [
    { path: '/old', name: 'old', lastOpenedAt: 1 },
    { path: '/gone', name: 'gone', lastOpenedAt: 3 },
    { path: '/new', name: 'new', lastOpenedAt: 2 },
  ]
  const exists = vi.fn(async (path: string) => path !== '/gone')
  expect(await resolveResumeTarget(prefs({ recentWorkspaces }), exists)).toEqual({
    kind: 'workspace',
    workspacePath: '/new',
  })
  expect(exists.mock.calls).toEqual([['/gone'], ['/new']])
  expect(recentWorkspaces.map((ws) => ws.path)).toEqual(['/old', '/gone', '/new'])
})

it('returns none for first run or all missing locations', async () => {
  expect(await resolveResumeTarget(prefs(), async () => true)).toEqual({ kind: 'none' })
  expect(
    await resolveResumeTarget(
      prefs({ recentWorkspaces: [{ path: '/gone', name: 'gone', lastOpenedAt: 1 }] }),
      async () => false,
    ),
  ).toEqual({ kind: 'none' })
})

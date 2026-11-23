import { DEFAULT_APP_PREFS } from '@phosphor/shared/models'
import type { PlanFacts, PlanSessionFact } from '../plan-facts'

/** A small This Mac: one repository with a worktree, a removed worktree, a sandbox and an archive. */

export const MIGRATION_ID = '00000000-0000-4000-8000-0000000000aa'
export const MACHINE_ID = '00000000-0000-4000-8000-0000000000bb'
export const USER_DATA = '/fixture/Phosphor'
export const REPO = '/fixture/src/app'
export const SANDBOX = '/fixture/Phosphor/sandboxes/scratch'
export const SESSIONS = '/fixture/.pi/agent/sessions'

const file = (dir: string, n: number) =>
  `${SESSIONS}/${dir}/2026-11-0${n}T10-00-00-000Z_00000000-0000-4000-8000-00000000000${n}.jsonl`

export function session(n: number, over: Partial<PlanSessionFact> = {}): PlanSessionFact {
  return {
    path: file('--fixture-src-app--', n),
    sessionId: `00000000-0000-4000-8000-00000000000${n}`,
    cwd: REPO,
    rootPath: REPO,
    worktree: false,
    createdAt: `2026-11-0${n}T10:00:00.000Z`,
    mtimeMs: Date.parse(`2026-11-0${n}T12:00:00.000Z`),
    lastActivityAt: `2026-11-0${n}T12:00:00.000Z`,
    name: `Lane ${n}`,
    branch: null,
    size: 1000 * n,
    cwdMissing: false,
    visible: true,
    ...over,
  }
}

export function planFacts(over: Partial<PlanFacts> = {}): PlanFacts {
  const s1 = session(1)
  const s2 = session(2, {
    cwd: `${REPO}/.phosphor/worktrees/feature`,
    worktree: true,
    branch: 'feature',
  })
  const s3 = session(3, {
    cwd: `${REPO}/.phosphor/worktrees/gone`,
    worktree: true,
    cwdMissing: true,
  })
  const s4 = session(4, { cwd: SANDBOX, rootPath: SANDBOX, path: file('--sandbox--', 4) })
  const s5 = session(5, { visible: false, name: 'Rewound predecessor' })
  return {
    migrationId: MIGRATION_ID,
    machineId: MACHINE_ID,
    userData: USER_DATA,
    prefs: {
      ...DEFAULT_APP_PREFS,
      pinnedSessions: [s1.path],
      laneMarkers: { [s2.path]: '🔥' },
      seenSessions: {
        [s1.path]: Date.parse('2026-11-01T11:00:00.000Z'),
        [s2.path]: Date.now() + 1e9,
      },
      rewoundSessions: { [s5.path.split('/').pop()!]: s1.path.split('/').pop()! },
      agentDirectivesByProject: {
        '/fixture/link-to-app': { ...DEFAULT_APP_PREFS.agentDirectives, laneCharter: false },
        '/fixture/elsewhere': DEFAULT_APP_PREFS.agentDirectives,
      },
    },
    folders: [
      { path: REPO, name: 'app', sandbox: false },
      { path: SANDBOX, name: 'scratch', sandbox: true },
    ],
    folderRealpaths: { '/fixture/link-to-app': REPO, [REPO]: REPO, [SANDBOX]: SANDBOX },
    duplicateFolders: [],
    sessions: [s1, s2, s3, s4, s5],
    archives: [
      {
        folder: REPO,
        record: {
          version: 1,
          id: 'f'.repeat(64),
          title: 'Archived',
          cwd: REPO,
          archivedAt: 1_700_000_000_000,
          state: 'archived',
          transcript: file('--fixture-src-app--', 6),
          metadata: { draftKey: `session:${file('--fixture-src-app--', 6)}` },
        },
      },
    ],
    sandboxRoot: '/fixture/Phosphor/sandboxes',
    routines: {
      database: `${USER_DATA}/daemon-migration/backup-x/routines.import.sqlite`,
      workspaces: [REPO],
      routines: 1,
      runs: 3,
    },
    accountBindings: {},
    ...over,
  }
}

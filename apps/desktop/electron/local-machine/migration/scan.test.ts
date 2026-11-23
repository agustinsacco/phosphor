import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_APP_PREFS, type SessionMeta, type WorktreeInfo } from '@phosphor/shared/models'
import { loadSqlite } from '@phosphor/session-runtime/sqlite'
import type { ArchiveRecord } from '@phosphor/session-runtime/lane-archive/storage'
import { buildPlan } from './plan'
import { ROUTINES_IMPORT, countRoutines } from './scan-routines'
import { archiveFolder, scanPlanFacts, type ScanPorts } from './scan'

const REPO = '/fx/src/app'
const LINK = '/fx/link-to-app'
const WT = `${REPO}/.phosphor/worktrees/feature`
const GONE = `${REPO}/.phosphor/worktrees/gone`
const SANDBOXES = '/fx/Phosphor/sandboxes'
const SANDBOX = `${SANDBOXES}/scratch`
const S = '/fx/.pi/agent/sessions'
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const file = (dir: string, n: number) => `${S}/${dir}/2026-11-0${n}T10-00-00-000Z_${ID(n)}.jsonl`

function meta(n: number, cwd: string, dir = '--fx-src-app--'): SessionMeta {
  return {
    path: file(dir, n),
    sessionId: ID(n),
    cwd,
    createdAt: `2026-11-0${n}T10:00:00.000Z`,
    name: `Lane ${n}`,
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    headroomSavedTokens: 0,
    entryCount: 2,
    branchCount: 1,
    mtimeMs: Date.parse(`2026-11-0${n}T12:00:00.000Z`),
    lastActivityAt: `2026-11-0${n}T12:00:00.000Z`,
  }
}

const worktree = (path: string, over: Partial<WorktreeInfo> = {}): WorktreeInfo =>
  ({
    path,
    realPath: path,
    branch: 'feature',
    head: 'abc',
    isMain: false,
    locked: false,
    prunable: false,
    dirty: 0,
    ...over,
  }) as WorktreeInfo

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'm3-scan-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function routinesCopy(): string {
  const path = join(root, 'routines.consistent.sqlite')
  const { DatabaseSync } = loadSqlite()
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE routines(id TEXT PRIMARY KEY, data TEXT)')
  db.exec('CREATE TABLE runs(id TEXT PRIMARY KEY, routine_id TEXT, data TEXT)')
  db.prepare('INSERT INTO routines VALUES (?,?)').run('r1', JSON.stringify({ workspacePath: LINK }))
  const run = (id: string, data: object) =>
    db.prepare('INSERT INTO runs VALUES (?,?,?)').run(id, 'r1', JSON.stringify(data))
  run('u1', { definition: { workspacePath: LINK }, sessionPath: file('--fx-src-app--', 7) })
  run('u2', {
    definition: { workspacePath: LINK },
    sessionPath: file('--fx-src-app--', 8),
    promoted: true,
  })
  db.close()
  return path
}

function ports(over: Partial<ScanPorts> = {}): ScanPorts {
  const s1 = meta(1, REPO)
  const s5 = meta(5, REPO)
  const sessions: Record<string, SessionMeta[]> = {
    [REPO]: [s1, s5, meta(7, REPO), meta(8, REPO)],
    [WT]: [meta(2, WT)],
    [GONE]: [meta(3, GONE)],
    [SANDBOX]: [meta(4, SANDBOX, '--sandbox--')],
  }
  return {
    migrationId: '00000000-0000-4000-8000-0000000000aa',
    machineId: '00000000-0000-4000-8000-0000000000bb',
    userData: '/fx/Phosphor',
    backupDir: root,
    prefs: {
      ...DEFAULT_APP_PREFS,
      recentWorkspaces: [
        { path: LINK, name: 'app', lastOpenedAt: 1 },
        { path: WT, name: 'feature', lastOpenedAt: 1 },
      ],
      rewoundSessions: { [s5.path.split('/').pop()!]: s1.path.split('/').pop()! },
    },
    sandboxBase: SANDBOXES,
    sandboxes: () => [{ path: SANDBOX, name: 'scratch' }],
    realpath: (p) => (p === LINK ? REPO : p),
    listSessions: async (dir) => sessions[dir] ?? [],
    listWorktrees: async () => [
      worktree(REPO, { isMain: true }),
      worktree(WT),
      worktree('/fx/stale', { prunable: true }),
    ],
    retainedWorkspaces: () => [GONE],
    archives: async () => [],
    exists: (p) => p !== GONE,
    size: () => 10,
    routinesCopy: null,
    ...over,
  }
}

describe('scanPlanFacts', () => {
  it('lists the sidebar lanes: realpathed recents, live and removed worktrees and sandboxes', async () => {
    const facts = await scanPlanFacts(ports())
    expect(facts.folders).toEqual([
      { path: REPO, name: 'app', sandbox: false },
      { path: SANDBOX, name: 'scratch', sandbox: true },
    ])
    expect(facts.folderRealpaths[LINK]).toBe(REPO)
    expect(facts.sandboxRoot).toBe(SANDBOXES)
    const visible = facts.sessions.filter((s) => s.visible).map((s) => s.sessionId)
    expect(visible.sort()).toEqual([1, 2, 3, 4, 7, 8].map(ID))
    const gone = facts.sessions.find((s) => s.sessionId === ID(3))!
    expect(gone).toMatchObject({ rootPath: REPO, worktree: true, cwdMissing: true })
    expect(facts.sessions.find((s) => s.sessionId === ID(2))).toMatchObject({
      worktree: true,
      branch: 'feature',
    })
  })

  it('a lane whose worktree folder is gone survives into the plan', async () => {
    const plan = buildPlan(await scanPlanFacts(ports()))
    const lane = plan.sections.lanes!.items.find((i) => i.cwd === GONE)
    expect(lane).toMatchObject({ rootPath: REPO, worktree: true })
    expect(plan.laneIds[lane!.sessionFile]).toBe(lane!.laneId)
  })

  it('folds a rewound predecessor and hides a routine-owned lane, as the sidebar does', async () => {
    const facts = await scanPlanFacts(ports({ routinesCopy: routinesCopy() }))
    const hidden = facts.sessions.filter((s) => !s.visible).map((s) => s.sessionId)
    expect(hidden.sort()).toEqual([ID(5), ID(7)])
    const plan = buildPlan(facts)
    expect(plan.sections.lanes!.items.map((i) => i.sessionFile)).not.toContain(
      file('--fx-src-app--', 7),
    )
  })

  it('copies the routines with every workspace realpathed, and leaves the backup copy alone', async () => {
    const copy = routinesCopy()
    const facts = await scanPlanFacts(ports({ routinesCopy: copy }))
    expect(facts.routines).toEqual({
      database: join(root, ROUTINES_IMPORT),
      workspaces: [REPO],
      routines: 1,
      runs: 2,
    })
    const { DatabaseSync } = loadSqlite()
    const db = new DatabaseSync(join(root, ROUTINES_IMPORT), { readOnly: true })
    const runs = db.prepare("SELECT json_extract(data,'$.definition.workspacePath') AS w FROM runs")
    expect(runs.all().map((r) => r.w)).toEqual([REPO, REPO])
    db.close()
    expect(countRoutines(copy)).toBe(1)
    expect(buildPlan(facts).refusals).toEqual([])
  })

  it('records a second spelling of a listed folder', async () => {
    const base = ports()
    const facts = await scanPlanFacts({
      ...base,
      prefs: {
        ...base.prefs,
        recentWorkspaces: [
          ...base.prefs.recentWorkspaces,
          { path: REPO, name: 'x', lastOpenedAt: 1 },
        ],
      },
    })
    expect(facts.duplicateFolders).toEqual([REPO])
    expect(buildPlan(facts).refusals).toContain('folder-spellings')
  })

  it('keeps only account bindings whose session file exists', async () => {
    const base = ports()
    const facts = await scanPlanFacts({
      ...base,
      prefs: {
        ...base.prefs,
        claudeAccounts: {
          ...DEFAULT_APP_PREFS.claudeAccounts!,
          bindings: { [file('--fx-src-app--', 1)]: 'a', [GONE]: 'b' },
        },
      },
    })
    expect(facts.accountBindings).toEqual({ [file('--fx-src-app--', 1)]: 'a' })
  })
})

describe('archiveFolder', () => {
  const folders = [
    { path: REPO, name: 'app', sandbox: false },
    { path: `${REPO}/nested`, name: 'n', sandbox: false },
  ]
  const record = (cwd: string, repository?: string) =>
    ({ cwd, ...(repository ? { repository } : {}) }) as ArchiveRecord
  it('picks the deepest migrated folder holding the lane, or null', () => {
    expect(archiveFolder(record(`${REPO}/nested/x`), folders, () => null)).toBe(`${REPO}/nested`)
    expect(archiveFolder(record(GONE, REPO), folders, () => null)).toBe(REPO)
    expect(archiveFolder(record('/elsewhere'), folders, () => null)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { isUuid } from '@phosphor/shared/control-api'
import { parseMigrationImport } from '@phosphor/shared/host-protocol-owner'
import { remoteLaneResourceKey } from '@phosphor/shared/remote-host'
import { repositoryIdForPath } from '@phosphor/session-runtime/host-local/repository-id'
import {
  MACHINE_ID,
  MIGRATION_ID,
  REPO,
  SANDBOX,
  USER_DATA,
  planFacts,
  session,
} from './__fixtures__/plan-facts'
import { buildPlan, planHash, sectionHash } from './plan'
import { laneTitle, plannedUuid } from './plan-sections'

describe('buildPlan', () => {
  it('is deterministic: the same facts give the same plan and hash', () => {
    const a = buildPlan(planFacts())
    const b = buildPlan(planFacts())
    expect(b).toEqual(a)
    expect(planHash(b)).toBe(planHash(a))
    const other = buildPlan(planFacts({ migrationId: '00000000-0000-4000-8000-0000000000cc' }))
    expect(planHash(other)).not.toBe(planHash(a))
  })

  it('maps every lane the sidebar shows, including a removed worktree and a sandbox, and nothing else', () => {
    const facts = planFacts()
    const plan = buildPlan(facts)
    const items = plan.sections.lanes!.items
    expect(items.map((i) => i.sessionFile)).toEqual(
      [1, 2, 3, 4].map((n) => facts.sessions[n - 1]!.path).sort(),
    )
    const gone = items.find((i) => i.cwd.endsWith('/gone'))!
    expect(gone).toMatchObject({ worktree: true, rootPath: REPO })
    expect(items.find((i) => i.rootPath === SANDBOX)).toBeDefined()
    expect(plan.expected.lanes).toBe(4)
    for (const item of items) {
      expect(isUuid(item.laneId)).toBe(true)
      expect(plan.laneIds[item.sessionFile]).toBe(item.laneId)
    }
  })

  it('leaves out lanes whose folder does not migrate', () => {
    const facts = planFacts()
    const plan = buildPlan({ ...facts, folders: facts.folders.slice(0, 1) })
    expect(plan.sections.lanes!.items.some((i) => i.rootPath === SANDBOX)).toBe(false)
  })

  it('builds sections the shared parsers accept', () => {
    const plan = buildPlan(planFacts())
    expect(plan.refusals).toEqual([])
    for (const section of Object.values(plan.sections)) {
      const wire = { migrationId: MIGRATION_ID, hash: sectionHash(section), ...section }
      expect(parseMigrationImport(wire), section.section).not.toBeNull()
    }
  })

  it('maps pins, markers, unread and the rewound relation by file path', () => {
    const facts = planFacts()
    const [s1, s2, , , s5] = facts.sessions
    const marks = buildPlan(facts).sections.marks!
    expect(marks.items).toEqual(
      expect.arrayContaining([
        { sessionFile: s1!.path, pinned: true, unread: true },
        { sessionFile: s2!.path, marker: '🔥' },
      ]),
    )
    expect(marks.items).toHaveLength(2)
    expect(marks.rewound).toEqual({ [s5!.path]: s1!.path })
  })

  it('keys per-folder directives by realpath and drops folders that do not migrate', () => {
    const policy = buildPlan(planFacts()).sections.policy!
    expect(Object.keys(policy.directivesByFolder)).toEqual([REPO])
    expect(policy.directivesByFolder[REPO]?.laneCharter).toBe(false)
  })

  it('rewrites an archive under a new lane id with the folder repository id and a re-keyed draft', () => {
    const plan = buildPlan(planFacts())
    const [manifest] = plan.sections.archives!.manifests
    const id = plannedUuid(MIGRATION_ID, 'archive', 'f'.repeat(64))
    expect(manifest).toMatchObject({
      id,
      cwd: REPO,
      state: 'archived',
      metadata: {
        repositoryId: repositoryIdForPath(REPO),
        draftKey: remoteLaneResourceKey(MACHINE_ID, id),
      },
    })
    expect(plan.witness).toEqual(
      expect.arrayContaining([manifest!.transcript, `${manifest!.transcript}.archived`]),
    )
  })

  it('points the account section at Desktop’s account folder', () => {
    expect(buildPlan(planFacts()).sections.accounts!.accountRoot).toBe(
      `${USER_DATA}/claude-accounts`,
    )
  })

  it('refuses over the service limits, for folder spellings and for a routine outside the folders', () => {
    const many = Array.from({ length: 65 }, (_, i) => ({
      path: `/r/${i}`,
      name: `r${i}`,
      sandbox: false,
    }))
    expect(buildPlan(planFacts({ folders: many })).refusals).toContain('limits')
    expect(buildPlan(planFacts({ duplicateFolders: ['/fixture/link-to-app'] })).refusals).toEqual([
      'folder-spellings',
    ])
    const routines = { database: '/x/r.sqlite', workspaces: ['/elsewhere'], routines: 1, runs: 0 }
    expect(buildPlan(planFacts({ routines })).refusals).toEqual(['routine-folder'])
  })

  it('refuses a section the service would reject, naming it', () => {
    const facts = planFacts()
    const prefs = {
      ...facts.prefs,
      claudeAccounts: {
        accounts: [{ id: 'acct-1', label: 'Me', credentialDir: '/elsewhere/x', addedAt: 1 }],
        mode: 'specific' as const,
        cursor: 0,
        cooldowns: {},
        bindings: {},
      },
    }
    expect(buildPlan({ ...facts, prefs }).refusals).toEqual(['invalid-accounts'])
  })

  it('picks at most ten distinct spot lanes, covering the special ones', () => {
    const facts = planFacts()
    const sessions = [...facts.sessions, ...[6, 7, 8, 9].flatMap((n) => [session(n)])]
    const plan = buildPlan({ ...facts, sessions })
    expect(new Set(plan.spots).size).toBe(plan.spots.length)
    expect(plan.spots.length).toBeLessThanOrEqual(10)
    expect(plan.spots).toEqual(
      expect.arrayContaining([facts.sessions[2]!.path, facts.sessions[3]!.path]),
    )
  })
})

describe('laneTitle', () => {
  it('prefers the name, flattens control characters and keeps 80 characters', () => {
    expect(laneTitle({ name: 'Named', firstUserText: 'text' })).toBe('Named')
    expect(laneTitle({ name: '  ', firstUserText: 'line one\nline\u202etwo' })).toBe(
      'line one line two',
    )
    expect(laneTitle({ firstUserText: 'x'.repeat(200) })).toHaveLength(80)
    expect(laneTitle({})).toBeNull()
  })
})

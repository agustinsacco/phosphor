import { describe, expect, it } from 'vitest'
import { parseClientFrame } from './host-protocol'
import {
  OWNER_LIMITS,
  OWNER_METHODS,
  OWNER_METHODS_ANY_LOCAL,
  isAnyLocalOwnerMethod,
  isOwnerMethod,
  parseOwnerParams,
  type OwnerMethod,
} from './host-protocol-owner'

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const MIGRATION = { migrationId: ID(1), hash: 'cd'.repeat(32) }
const ROOT = '/Users/me/Library/Application Support/Phosphor/claude-accounts'
const TIME = '2026-01-01T00:00:00.000Z'
const DIRECTIVES = {
  machineAwareness: true,
  worktreeGuard: true,
  laneCharter: false,
  subagentPolicy: true,
}

/** One valid params value per method; undefined for paramless ones. */
const VALID: { readonly [M in OwnerMethod]: unknown } = {
  'machine.local': undefined,
  'machine.identity.reload': undefined,
  'machine.enroll': { action: 'begin' },
  'machine.owner': { action: 'release' },
  'machine.pause': { action: 'begin', purpose: 'update', deadlineMs: 60_000 },
  'app.service.register': {
    service: 'brain',
    endpoint: '/private/brain/rpc.sock',
    token: 't0k',
    recall: true,
  },
  'headroom.status': undefined,
  'headroom.set': { enabled: false },
  'owner.index': { after: 'page-2' },
  'owner.migrate.begin': { migrationId: ID(1), desktopVersion: '0.1.683', merge: true },
  'owner.migrate.import': { ...MIGRATION, section: 'artifacts', sourceDir: '/u/artifacts' },
  'owner.migrate.status': { migrationId: ID(1) },
  'owner.migrate.commit': { migrationId: ID(1) },
  'owner.migrate.abort': { migrationId: ID(1) },
  'owner.lease.take': { paths: ['/repo/.phosphor/worktrees/a'], ttlMs: 60_000 },
  'owner.lease.renew': { leaseId: ID(2) },
  'owner.lease.release': { leaseId: ID(2) },
  'owner.transcript.page': { laneId: ID(3), offset: 0, maxBytes: OWNER_LIMITS.transcriptPageBytes },
  'owner.account.prepare': undefined,
  'owner.account.register': { accountId: ID(4), label: 'me@example.com', plan: 'max' },
  'owner.account.discard': { accountId: ID(4) },
}
const INVALID: { readonly [M in OwnerMethod]: unknown } = {
  'machine.local': { any: 1 },
  'machine.identity.reload': 'x',
  'machine.enroll': { action: 'approve' },
  'machine.owner': {},
  'machine.pause': {
    action: 'begin',
    purpose: 'update',
    deadlineMs: OWNER_LIMITS.pauseDeadlineMs + 1,
  },
  'app.service.register': {
    service: 'brain',
    endpoint: 'http://0.0.0.0:1',
    token: 't',
    recall: true,
  },
  'headroom.status': [],
  'headroom.set': { enabled: 'yes' },
  'owner.index': { after: 'a b' },
  'owner.migrate.begin': { migrationId: ID(1), desktopVersion: 'latest' },
  'owner.migrate.import': { ...MIGRATION, section: 'artifacts', sourceDir: 'relative' },
  'owner.migrate.status': { migrationId: 'x' },
  'owner.migrate.commit': {},
  'owner.migrate.abort': null,
  'owner.lease.take': { paths: [], ttlMs: 1 },
  'owner.lease.renew': { leaseId: 1 },
  'owner.lease.release': undefined,
  'owner.transcript.page': {
    laneId: ID(3),
    offset: 0,
    maxBytes: OWNER_LIMITS.transcriptPageBytes + 1,
  },
  'owner.account.prepare': { accountId: ID(4) },
  'owner.account.register': { accountId: ID(4), label: 'x', credentialDir: undefined, email: '' },
  'owner.account.discard': { accountId: 'default' },
}

describe('owner methods', () => {
  it('are call methods the frame parser admits, and only they are owner methods', () => {
    for (const method of OWNER_METHODS) {
      expect(isOwnerMethod(method)).toBe(true)
      const call = { type: 'call', id: 'c', method }
      expect(parseClientFrame(JSON.stringify(call)), method).toStrictEqual({
        ok: true,
        frame: call,
      })
    }
    for (const method of ['ops.run', 'lane.state', 'owner', 'machine.settings.read'])
      expect(isOwnerMethod(method), method).toBe(false)
  })

  it('admits any local principal to three methods only', () => {
    expect(OWNER_METHODS.filter(isAnyLocalOwnerMethod)).toStrictEqual([...OWNER_METHODS_ANY_LOCAL])
  })

  it('keeps owner limits apart from HOST_LIMITS', () => {
    expect(OWNER_LIMITS).toStrictEqual({
      callAnswerMs: 120_000,
      indexLanesPerPage: 500,
      leasePaths: 64,
      leaseTtlMs: 600_000,
      pauseDeadlineMs: 600_000,
      transcriptPageBytes: 4 * 1024 * 1024,
      transcriptFileBytes: 2 * 1024 * 1024 * 1024,
      pageTokenChars: 256,
      appServiceTokenChars: 256,
    })
  })
})

describe('parseOwnerParams', () => {
  it.each(OWNER_METHODS)('accepts valid %s params and refuses invalid ones', (method) => {
    const valid = VALID[method]
    expect(parseOwnerParams(method, valid)).toStrictEqual(valid)
    expect(parseOwnerParams(method, INVALID[method])).toBeNull()
  })

  it.each(['http://127.0.0.1:41234', 'relative', '/a/../s', '/bad\0sock', '/' + 'é'.repeat(52)])(
    'refuses unsafe Brain endpoint %s',
    (endpoint) => {
      expect(
        parseOwnerParams('app.service.register', {
          service: 'brain',
          token: 't',
          recall: true,
          endpoint,
        }),
      ).toBeNull()
    },
  )

  it('takes `{}` for paramless methods and never a path on account registration', () => {
    expect(parseOwnerParams('machine.local', {})).toBeUndefined()
    expect(
      parseOwnerParams('owner.account.register', {
        accountId: ID(4),
        label: 'A',
        credentialDir: '/tmp/x',
      }),
    ).toStrictEqual({ accountId: ID(4), label: 'A' })
  })
})

describe('owner.migrate.import sections', () => {
  const section = (s: object) => parseOwnerParams('owner.migrate.import', { ...MIGRATION, ...s })

  it('carries lanes with Desktop-minted ids, titles, order and timestamps', () => {
    const item = {
      laneId: ID(10),
      sessionFile: '/u/.pi/agent/sessions/--repo--/a.jsonl',
      cwd: '/repo',
      rootPath: '/repo',
      worktree: false,
      title: 'Fix the build',
      branch: 'main',
      model: { provider: 'anthropic', id: 'claude' },
      createdAt: TIME,
      updatedAt: TIME,
    }
    expect(section({ section: 'lanes', items: [item] })).toStrictEqual({
      ...MIGRATION,
      section: 'lanes',
      items: [item],
    })
    expect(section({ section: 'lanes', items: [item, item] })).toBeNull()
    expect(section({ section: 'lanes', items: [{ ...item, title: ' padded' }] })).toBeNull()
    expect(section({ section: 'lanes', items: [{ ...item, createdAt: 'yesterday' }] })).toBeNull()
  })

  it('carries archives as new daemon manifests keyed by a lane UUID', () => {
    const manifest = {
      version: 1,
      id: ID(11),
      title: 'Old lane',
      cwd: '/repo/.phosphor/worktrees/x',
      archivedAt: 1,
      state: 'archived',
      worktree: true,
      transcript: '/u/.pi/agent/sessions/--x--/b.jsonl',
      identity: { dev: 1, ino: 2, directory: '/u/.pi/agent/sessions/--x--' },
      checkout: { dev: 1, ino: 3, path: '/repo/.phosphor/worktrees/x' },
      metadata: { repositoryId: '0123456789abcdef', draftKey: '["remote","h","session","l"]' },
    }
    expect(section({ section: 'archives', manifests: [manifest] })).toMatchObject({
      manifests: [manifest],
    })
    for (const bad of [{ id: 'a'.repeat(64) }, { metadata: { draftKey: 'x' } }, { cwd: 'repo' }])
      expect(section({ section: 'archives', manifests: [{ ...manifest, ...bad }] })).toBeNull()
  })

  it('keeps account folders inside the account root and bindings to known accounts', () => {
    const account = { id: ID(12), label: 'me', credentialDir: `${ROOT}/${ID(12)}`, addedAt: 1 }
    const accounts = {
      section: 'accounts',
      accountRoot: ROOT,
      accounts: [{ id: 'default', label: 'Terminal', credentialDir: null, addedAt: 0 }, account],
      mode: 'ordered',
      cursor: 0,
      cooldowns: { [ID(12)]: 5 },
      bindings: { '/u/s.jsonl': ID(12) },
    }
    expect(section(accounts)).toMatchObject({
      accountRoot: ROOT,
      bindings: { '/u/s.jsonl': ID(12) },
    })
    for (const bad of [
      { accounts: [{ ...account, credentialDir: `/elsewhere/${ID(12)}` }] },
      { bindings: { '/u/s.jsonl': ID(99) } },
      { pinnedId: ID(99) },
      { cooldowns: { ['__proto__']: 1 } },
    ])
      expect(section({ ...accounts, ...bad }), JSON.stringify(bad)).toBeNull()
  })

  it('reads folders, policy, marks and routines', () => {
    const cases = [
      {
        section: 'folders',
        items: [{ path: '/repo', name: 'repo', order: 0, sandbox: true }],
        sandboxRoot: '/s',
      },
      {
        section: 'policy',
        contextBudget: '',
        agentDirectives: DIRECTIVES,
        directivesByFolder: { '/repo': DIRECTIVES },
        autoNameLanes: true,
        contextFiles: { claude: true, agents: false },
        headroom: false,
      },
      {
        section: 'marks',
        items: [{ sessionFile: '/s/a.jsonl', pinned: true, marker: '🦊', unread: true }],
        rewound: { '/s/a.jsonl': '/s/b.jsonl' },
      },
      { section: 'routines', database: '/backup/routines.sqlite', workspaces: ['/repo'] },
    ]
    for (const value of cases) expect(section(value)).toStrictEqual({ ...MIGRATION, ...value })
    expect(section({ section: 'marks', items: [], rewound: { a: '/b' } })).toBeNull()
    expect(section({ section: 'unknown' })).toBeNull()
    expect(
      parseOwnerParams('owner.migrate.import', { section: 'artifacts', sourceDir: '/a' }),
    ).toBeNull()
  })
})

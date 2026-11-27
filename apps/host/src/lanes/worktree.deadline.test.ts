import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as exec from '@phosphor/session-runtime/git/git-exec'
import { prepareLaneFolder } from './worktree'

const timeoutMessage = 'Git took too long to create the worktree'
let root: string
let now: number
const log = vi.fn()
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worktree-deadline-'))
  mkdirSync(join(root, '.git'))
  now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  log.mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const prepare = () => prepareLaneFolder({ root, worktree: { branch: 'private-ref' }, log })
const exit = (code: number) => Object.assign(new Error('private argv'), { code })

function fakeGit(add: () => never, advance = (_args: string[]) => {}) {
  return vi.spyOn(exec, 'git').mockImplementation(async (_root, args) => {
    advance(args)
    if (args[0] === 'check-ref-format') return 'private-ref'
    if (args[0] === 'show-ref') throw exit(1)
    if (args[0] === 'rev-parse') return args[1] === '--git-common-dir' ? '.git' : 'a'.repeat(40)
    if (args[0] === 'worktree' && args[1] === 'add') add()
    return ''
  })
}

it('caps just add at 90s and logs the actual timeout without revealing argv or stderr secrets', async () => {
  const git = fakeGit(() => {
    now = 90_000
    throw Object.assign(new Error('private argv'), {
      code: null,
      killed: true,
      signal: 'SIGTERM',
      stderr: 'hook secret\n',
    })
  })
  await expect(prepare()).rejects.toThrow(timeoutMessage)
  expect(git.mock.calls.find(([, args]) => args[0] === 'check-ref-format')?.[2]?.timeout).toBe(
    30_000,
  )
  expect(git.mock.calls.find(([, args]) => args[1] === 'add')?.[2]?.timeout).toBe(90_000)
  expect(log).toHaveBeenCalledWith('host', 'lane.worktree_git_failed', {
    command: 'git worktree add',
    timeout: true,
    stderrTail: '[unrecognized stderr omitted]',
  })
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private|secret/)
})

it('budgets preflight, gives add only the time left and reserves a separate cleanup window', async () => {
  const git = fakeGit(
    () => {
      now = 95_000
      throw Object.assign(new Error(), { code: null, killed: true, signal: 'SIGTERM' })
    },
    (args) => {
      if (args[0] === 'symbolic-ref') now += 25_000
    },
  )
  await expect(prepare()).rejects.toThrow(timeoutMessage)
  expect(git.mock.calls.find(([, args]) => args[1] === 'add')?.[2]?.timeout).toBe(45_000)
  expect(git.mock.calls.findLast(([, args]) => args[1] === 'list')?.[2]?.timeout).toBe(10_000)
})

it('does not start add when preparation has exhausted its budget and still cleans up', async () => {
  const git = fakeGit(
    () => {
      throw new Error('must not start')
    },
    (args) => {
      if (args[0] === 'update-ref' && args[1] !== '-d') now = 95_000
    },
  )
  await expect(prepare()).rejects.toThrow(timeoutMessage)
  expect(git.mock.calls.some(([, args]) => args[1] === 'add')).toBe(false)
  expect(git.mock.calls.findLast(([, args]) => args[1] === 'list')?.[2]?.timeout).toBe(10_000)
  expect(log).toHaveBeenCalledWith('host', 'lane.worktree_git_failed', {
    command: 'git worktree add',
    timeout: true,
  })
})

it('logs non-timeouts with an exit code and a bounded, redacted stderr tail', async () => {
  fakeGit(() => {
    throw Object.assign(exit(128), {
      stderr:
        'sensitive tail '.repeat(5000) +
        "\nfatal: cannot create directory at 'secret': Permission denied\n",
    })
  })
  await expect(prepare()).rejects.toThrow('The worktree could not be created.')
  expect(log).toHaveBeenCalledWith('host', 'lane.worktree_git_failed', {
    command: 'git worktree add',
    exitCode: 128,
    stderrTail: '[unrecognized stderr omitted]\nfatal: cannot create directory: Permission denied',
  })
})

const killedAdd = () => {
  now = 95_000
  throw Object.assign(new Error(), { code: null, killed: true, signal: 'SIGTERM' })
}
const removedHalfMade = (git: ReturnType<typeof fakeGit>) =>
  git.mock.calls
    .filter(([, args]) => args[0] === 'worktree' && (args[1] === 'remove' || args[1] === 'prune'))
    .map(([, args, options]) => [args.slice(1, 4).join(' '), options?.timeout])

it.each([
  ['an existing branch', undefined],
  ['a fresh branch', true as const],
])(
  'removes and prunes the worktree a killed add left for %s, inside the cleanup reserve',
  async (_name, fresh) => {
    const git = fakeGit(killedAdd)
    await expect(
      prepareLaneFolder({
        root,
        worktree: { branch: 'private-ref', ...(fresh ? { fresh } : {}) },
        log,
      }),
    ).rejects.toThrow(timeoutMessage)
    expect(removedHalfMade(git)).toEqual([
      ['remove --force --force', 10_000],
      ['prune', 10_000],
    ])
    const remove = git.mock.calls.find(([, args]) => args[1] === 'remove')?.[1]
    expect(remove?.at(-1)).toBe(join(root, '.phosphor', 'worktrees', 'private-ref'))
    // The branch it made goes after the worktree that held it.
    const order = git.mock.calls.map(([, args]) => args.join(' '))
    expect(order.findIndex((c) => c.startsWith('update-ref -d'))).toBeGreaterThan(
      order.findIndex((c) => c.startsWith('worktree prune')),
    )
  },
)

it('never removes a worktree folder when add failed on its own or never started', async () => {
  const failed = fakeGit(() => {
    throw Object.assign(exit(128), { stderr: 'fatal: destination already exists\n' })
  })
  await expect(prepare()).rejects.toThrow('The worktree could not be created.')
  expect(removedHalfMade(failed)).toEqual([])
  vi.restoreAllMocks()
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  now = 0
  const late = fakeGit(
    () => {
      throw new Error('must not start')
    },
    (args) => {
      if (args[0] === 'update-ref' && args[1] !== '-d') now = 95_000
    },
  )
  await expect(prepare()).rejects.toThrow(timeoutMessage)
  expect(removedHalfMade(late)).toEqual([])
})

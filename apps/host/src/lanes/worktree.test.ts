import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as exec from '@phosphor/session-runtime/git/git-exec'
import { branchMerged, deleteMergedBranch } from './delete'
import { LaneFolderError, prepareLaneFolder } from './worktree'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, openSync: vi.fn(actual.openSync), fstatSync: vi.fn(actual.fstatSync) }
})

let temp: string
let root: string
const run = (args: string[], cwd = root) =>
  exec.git(cwd, args, { trim: true, env: { GIT_TERMINAL_PROMPT: '0' } })
const prepare = (branch: string) => prepareLaneFolder({ root, worktree: { branch } })
beforeEach(async () => {
  const actual = await vi.importActual<typeof fs>('node:fs')
  vi.mocked(fs.openSync).mockImplementation(actual.openSync)
  vi.mocked(fs.fstatSync).mockImplementation(actual.fstatSync)
  temp = realpathSync.native(mkdtempSync(join(tmpdir(), 'lane-folder-')))
  root = join(temp, 'repo')
  mkdirSync(root)
  await run(['init', '-b', 'main'])
  await run(['config', 'user.name', 'Lane test'])
  await run(['config', 'user.email', 'lane@example.invalid'])
  await run(['commit', '--allow-empty', '-m', 'base'])
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(temp, { recursive: true, force: true })
})
it('returns the repository branch and harmless undo; detached and non-git return null', async () => {
  const folder = await prepareLaneFolder({ root, worktree: null })
  expect(folder).toMatchObject({ cwd: root, branch: 'main' })
  await folder.undo()
  await run(['checkout', '--detach'])
  expect((await prepareLaneFolder({ root, worktree: null })).branch).toBeNull()
  expect((await prepareLaneFolder({ root: temp, worktree: null })).branch).toBeNull()
  await run(['checkout', '-b', 'unicode-é'])
  expect((await prepareLaneFolder({ root, worktree: null })).branch).toBeNull()
})
it('creates from origin/main without tracking or fetch, then removes its folder and branch', async () => {
  const remote = join(temp, 'remote.git')
  await run(['init', '--bare', remote])
  await run(['remote', 'add', 'origin', remote])
  await run(['push', 'origin', 'main'])
  await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'])
  const base = await run(['rev-parse', 'origin/main'])
  await run(['commit', '--allow-empty', '-m', 'local only'])
  const folder = await prepare('feature/remote')
  expect(folder.cwd).toBe(join(root, '.phosphor', 'worktrees', 'feature-remote'))
  expect(await run(['rev-parse', 'feature/remote'])).toBe(base)
  expect(await run(['for-each-ref', '--format=%(upstream)', 'refs/heads/feature/remote'])).toBe('')
  await folder.undo()
  expect(existsSync(folder.cwd)).toBe(false)
  await expect(run(['show-ref', '--verify', 'refs/heads/feature/remote'])).rejects.toThrow()
})
it('creates without a remote, accepts an existing free branch, and writes exclude once', async () => {
  const base = await run(['rev-parse', 'main'])
  const fresh = await prepare('new')
  expect(await run(['rev-parse', 'new'])).toBe(base)
  await fresh.undo()
  await run(['branch', 'free'])
  const existing = await prepare('free')
  await existing.undo()
  expect(await run(['rev-parse', 'free'])).toBe(base)
  expect(
    readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')
      .split('\n')
      .filter((s) => s === '/.phosphor/'),
  ).toHaveLength(1)
  expect(await run(['status', '--porcelain'])).toBe('')
})
it('falls back through master, current branch, and HEAD when the remote default is absent', async () => {
  await run(['branch', '-m', 'master'])
  const master = await run(['rev-parse', 'master'])
  await run(['checkout', '-b', 'other'])
  await run(['commit', '--allow-empty', '-m', 'other'])
  await expect(prepare('master')).rejects.toThrow('The default branch stays in the main tree.')
  const fromMaster = await prepare('from-master')
  expect(await run(['rev-parse', 'from-master'])).toBe(master)
  await fromMaster.undo()
  await run(['checkout', 'master'])
  await run(['branch', '-m', 'trunk'])
  await expect(prepare('trunk')).rejects.toThrow('The default branch stays in the main tree.')
  await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing'])
  const folder = await prepare('from-head')
  expect(await run(['rev-parse', 'from-head'])).toBe(await run(['rev-parse', 'HEAD']))
  await folder.undo()
}, 30_000)
it('refuses default, checked out branch and existing folder with fixed sentences', async () => {
  await expect(prepare('main')).rejects.toThrow('The default branch stays in the main tree.')
  await run(['branch', 'elsewhere'])
  await run(['worktree', 'add', join(temp, 'elsewhere'), 'elsewhere'])
  await expect(prepare('elsewhere')).rejects.toThrow(
    'That branch is checked out in another worktree.',
  )
  const folder = await prepare('existing')
  await expect(prepare('existing')).rejects.toThrow(
    'A worktree folder for that branch already exists.',
  )
  await folder.undo()
})
it('validates git output as well as wire and slug limits', async () => {
  for (const branch of [
    'bad..name',
    '-bad',
    'x'.repeat(101),
    '.bad',
    'bad/../name',
    'bad:name',
    '',
  ])
    await expect(prepare(branch)).rejects.toThrow('That branch name is not valid.')
  const exact = await prepare('x'.repeat(100))
  await exact.undo()
  const realGit = exec.git
  const spy = vi
    .spyOn(exec, 'git')
    .mockImplementation((cwd, args, options) =>
      args[0] === 'check-ref-format' ? Promise.resolve('other\n') : realGit(cwd, args, options),
    )
  await expect(prepare('valid')).rejects.toThrow('That branch name is not valid.')
  spy.mockImplementation((cwd, args, options) =>
    args[0] === 'check-ref-format'
      ? Promise.reject(new Error('private URL'))
      : realGit(cwd, args, options),
  )
  await expect(prepare('valid')).rejects.toThrow('That branch name is not valid.')
})
it.each(['.phosphor', 'worktrees'])(
  'refuses a symlinked %s without creating anything outside',
  async (name) => {
    const outside = join(temp, 'outside')
    mkdirSync(outside)
    if (name === 'worktrees') mkdirSync(join(root, '.phosphor'))
    symlinkSync(outside, name === '.phosphor' ? join(root, name) : join(root, '.phosphor', name))
    await expect(prepare('safe')).rejects.toThrow('The worktree could not be created.')
    expect(existsSync(join(outside, 'safe'))).toBe(false)
    expect(existsSync(join(outside, 'worktrees'))).toBe(false)
  },
)
it('undo keeps a moved branch and refuses dirty worktrees without throwing or leaking output', async () => {
  const moved = await prepare('moved')
  await run(['commit', '--allow-empty', '-m', 'moved'], moved.cwd)
  const commit = await run(['rev-parse', 'moved'])
  await moved.undo()
  expect(await run(['rev-parse', 'moved'])).toBe(commit)
  const logs: unknown[] = []
  const dirty = await prepareLaneFolder({
    root,
    worktree: { branch: 'dirty' },
    log: (_scope, message, data) => logs.push({ message, data }),
  })
  writeFileSync(join(dirty.cwd, 'private'), 'private')
  await expect(dirty.undo()).resolves.toBeUndefined()
  expect(existsSync(dirty.cwd)).toBe(true)
  expect(await run(['rev-parse', 'dirty'])).toBe(await run(['rev-parse', 'main']))
  expect(logs).toEqual([{ message: 'lane.worktree_undo_failed', data: {} }])
})
it('maps git failure to the fixed generic sentence', async () => {
  const realGit = exec.git
  vi.spyOn(exec, 'git').mockImplementation((cwd, args, options) =>
    args[0] === 'worktree' && args[1] === 'add'
      ? Promise.reject(new Error('private URL'))
      : realGit(cwd, args, options),
  )
  await expect(prepare('failure')).rejects.toEqual(
    new LaneFolderError('The worktree could not be created.'),
  )
})

it('undo cleans a failed post-checkout hook without force', async () => {
  const hooks = join(temp, 'hooks')
  mkdirSync(hooks)
  const hook = join(hooks, 'post-checkout')
  writeFileSync(hook, '#!/bin/sh\nexit 1\n')
  chmodSync(hook, 0o755)
  await run(['config', 'core.hooksPath', hooks])
  await expect(prepare('hook-failure')).rejects.toThrow('The worktree could not be created.')
  expect(await run(['worktree', 'list', '--porcelain'])).not.toContain('hook-failure')
  await expect(run(['show-ref', '--verify', 'refs/heads/hook-failure'])).rejects.toThrow()
})
it('checks the final realpath before returning a folder', async () => {
  const original = realpathSync.native
  vi.spyOn(realpathSync, 'native').mockImplementation((path) =>
    original(path) === join(root, '.phosphor', 'worktrees', 'changed') ? temp : original(path),
  )
  await expect(prepare('changed')).rejects.toThrow('The worktree could not be created.')
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'changed'))).toBe(false)
})
it.each(['SAFE_CODE', 'private/path', 'x'.repeat(65)])(
  'logs only safe undo codes (%s), never throws even if logging fails',
  async (code) => {
    const realGit = exec.git
    const logs: unknown[] = []
    const folder = await prepareLaneFolder({
      root,
      worktree: { branch: 'logging' },
      log: (_scope, message, data) => {
        logs.push({ message, data })
        throw new Error('logger')
      },
    })
    vi.spyOn(exec, 'git').mockImplementation((cwd, args, options) =>
      args[0] === 'worktree' && args[1] === 'remove'
        ? Promise.reject(Object.assign(new Error('private output'), { code }))
        : realGit(cwd, args, options),
    )
    await expect(folder.undo()).resolves.toBeUndefined()
    expect(logs).toEqual([
      { message: 'lane.worktree_undo_failed', data: code === 'SAFE_CODE' ? { code } : {} },
    ])
  },
)
it('uses argument arrays, disables prompts on every git call, and never fetches', async () => {
  const spy = vi.spyOn(exec, 'git')
  await (await prepare('no-network')).undo()
  expect(spy.mock.calls.length).toBeGreaterThan(0)
  for (const [_cwd, args, options] of spy.mock.calls) {
    expect(options?.env).toEqual({ GIT_TERMINAL_PROMPT: '0' })
    expect(args[0]).not.toBe('fetch')
  }
})

it('pins the base commit even if a local ref moves before git add', async () => {
  const base = await run(['rev-parse', 'main'])
  await run(['commit', '--allow-empty', '-m', 'next'])
  const next = await run(['rev-parse', 'main'])
  await run(['reset', '--hard', base])
  const realGit = exec.git
  vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'add')
      await realGit(root, ['update-ref', 'refs/heads/main', next])
    return realGit(cwd, args, options)
  })
  const folder = await prepare('pinned')
  expect(await run(['rev-parse', 'pinned'])).toBe(base)
  await folder.undo()
})
it('a failed existing-branch add never deletes that branch', async () => {
  await run(['branch', 'free-failure'])
  const hooks = join(temp, 'hooks')
  mkdirSync(hooks)
  writeFileSync(join(hooks, 'post-checkout'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  await run(['config', 'core.hooksPath', hooks])
  await expect(prepare('free-failure')).rejects.toThrow('The worktree could not be created.')
  expect(await run(['rev-parse', 'free-failure'])).toBe(await run(['rev-parse', 'main']))
  expect(await run(['worktree', 'list', '--porcelain'])).not.toContain('free-failure')
})
it('leaves and logs an unregistered folder after a failed add', async () => {
  const realGit = exec.git
  const logs: unknown[] = []
  vi.spyOn(exec, 'git').mockImplementation((cwd, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      mkdirSync(join(root, '.phosphor', 'worktrees', 'unregistered'))
      return Promise.reject(new Error('private output'))
    }
    return realGit(cwd, args, options)
  })
  await expect(
    prepareLaneFolder({
      root,
      worktree: { branch: 'unregistered' },
      log: (_scope, message, data) => logs.push({ message, data }),
    }),
  ).rejects.toThrow('The worktree could not be created.')
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'unregistered'))).toBe(true)
  expect(logs).toEqual([{ message: 'lane.worktree_undo_failed', data: {} }])
})

it('refuses a branch created concurrently at the base without owning or deleting it', async () => {
  const realGit = exec.git
  const base = await run(['rev-parse', 'main'])
  vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'update-ref' && args[1] === 'refs/heads/raced')
      await realGit(root, ['branch', 'raced', base])
    return realGit(cwd, args, options)
  })
  await expect(prepare('raced')).rejects.toThrow('The worktree could not be created.')
  expect(await run(['rev-parse', 'raced'])).toBe(base)
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'raced'))).toBe(false)
})
it('uses compare-and-swap delete even when the branch moves at the deletion call', async () => {
  const folder = await prepare('delete-race')
  await run(['commit', '--allow-empty', '-m', 'next'])
  const next = await run(['rev-parse', 'main'])
  const realGit = exec.git
  vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
    if ((args[0] === 'update-ref' && args[1] === '-d') || args[0] === 'branch')
      await realGit(root, ['update-ref', 'refs/heads/delete-race', next])
    return realGit(cwd, args, options)
  })
  await folder.undo()
  expect(await run(['rev-parse', 'delete-race'])).toBe(next)
})
it('does not remove a partially registered worktree on a different branch', async () => {
  await run(['branch', 'other'])
  const realGit = exec.git
  const path = join(root, '.phosphor', 'worktrees', 'partial')
  vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'worktree' && args[1] === 'add') {
      await realGit(root, ['worktree', 'add', path, 'other'])
      throw new Error('add failed')
    }
    return realGit(cwd, args, options)
  })
  await expect(prepare('partial')).rejects.toThrow('The worktree could not be created.')
  expect(existsSync(path)).toBe(true)
  expect(await run(['symbolic-ref', '--short', 'HEAD'], path)).toBe('other')
})
it.each(['info', 'exclude'])('never follows a linked %s to write outside', async (name) => {
  const outside = join(temp, 'outside')
  mkdirSync(outside)
  const file = join(outside, 'exclude')
  writeFileSync(file, 'private\n/.phosphor/\n')
  const info = join(root, '.git', 'info')
  const target = name === 'info' ? info : join(info, 'exclude')
  rmSync(target, { recursive: true })
  symlinkSync(name === 'info' ? outside : file, target)
  await expect(prepare('linked')).rejects.toThrow('The worktree could not be created.')
  expect(readFileSync(file, 'utf8')).toBe('private\n/.phosphor/\n')
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'linked'))).toBe(false)
  await expect(run(['show-ref', '--verify', 'refs/heads/linked'])).rejects.toThrow()
})
it('refuses a non-regular or oversized exclude and accepts the exact read cap', async () => {
  const exclude = join(root, '.git', 'info', 'exclude')
  rmSync(exclude)
  mkdirSync(exclude)
  await expect(prepare('directory')).rejects.toThrow('The worktree could not be created.')
  rmSync(exclude, { recursive: true })
  writeFileSync(exclude, 'x'.repeat(1024 * 1024 + 1))
  await expect(prepare('oversize')).rejects.toThrow('The worktree could not be created.')
  writeFileSync(exclude, '/.phosphor/\n' + '#'.repeat(1024 * 1024 - 12))
  expect(readFileSync(exclude).length).toBe(1024 * 1024)
  await (await prepare('exact-cap')).undo()
})
it.each(['before-check', 'at-spawn'])(
  'catches a containment swap %s and leaves outside empty',
  async (when) => {
    const outside = join(temp, 'outside')
    mkdirSync(outside)
    const realGit = exec.git
    const swap = () => {
      const path = join(root, '.phosphor', 'worktrees')
      renameSync(path, path + '-old')
      symlinkSync(outside, path)
    }
    const spy = vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
      if (when === 'at-spawn' && args[0] === 'worktree' && args[1] === 'add') swap()
      const result = await realGit(cwd, args, options)
      if (when === 'before-check' && args[0] === 'update-ref' && args[1] === 'refs/heads/swapped')
        swap()
      return result
    })
    await expect(prepare('swapped')).rejects.toThrow('The worktree could not be created.')
    expect(readdirSync(outside)).toEqual([])
    if (when === 'before-check')
      expect(spy.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'add')).toBe(
        false,
      )
  },
)

it('refuses a link swapped in between reading and appending exclude', async () => {
  const file = join(temp, 'outside-exclude')
  const exclude = join(root, '.git', 'info', 'exclude')
  writeFileSync(file, 'private\n')
  const { openSync: realOpen } = await vi.importActual<typeof fs>('node:fs')
  vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
    if (path === exclude && typeof flags === 'number' && flags & fs.constants.O_APPEND) {
      rmSync(exclude)
      symlinkSync(file, exclude)
    }
    return realOpen(path, flags, mode)
  })
  await expect(prepare('append-link')).rejects.toThrow('The worktree could not be created.')
  expect(readFileSync(file, 'utf8')).toBe('private\n')
})
it('creates and deletes a branch with SHA-256 compare-and-swap object ids', async () => {
  rmSync(join(root, '.git'), { recursive: true })
  await run(['init', '--object-format=sha256', '-b', 'main'])
  await run(['config', 'user.name', 'Lane test'])
  await run(['config', 'user.email', 'lane@example.invalid'])
  await run(['commit', '--allow-empty', '-m', 'base'])
  const folder = await prepare('sha256')
  expect(await run(['rev-parse', 'sha256'])).toHaveLength(64)
  await folder.undo()
  await expect(run(['show-ref', '--verify', 'refs/heads/sha256'])).rejects.toThrow()
})

it.each(['read', 'append'])('requires a regular descriptor on exclude %s', async (step) => {
  const { fstatSync: actualStat } = await vi.importActual<typeof fs>('node:fs')
  const exclude = join(root, '.git', 'info', 'exclude')
  writeFileSync(exclude, step === 'read' ? '/.phosphor/\n' : 'private\n')
  vi.mocked(fs.fstatSync).mockImplementation((fd) => {
    const stat = actualStat(fd)
    const flags = vi.mocked(fs.openSync).mock.calls.at(-1)?.[1]
    if (step === 'read' || (typeof flags === 'number' && flags & fs.constants.O_APPEND))
      vi.spyOn(stat, 'isFile').mockReturnValue(false)
    return stat
  })
  await expect(prepare('not-regular')).rejects.toThrow('The worktree could not be created.')
  expect(readFileSync(exclude, 'utf8')).toBe(step === 'read' ? '/.phosphor/\n' : 'private\n')
})
it('creates absent info and exclude without recursive mkdir', async () => {
  rmSync(join(root, '.git', 'info'), { recursive: true })
  const folder = await prepare('no-info')
  expect(readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8')).toBe('/.phosphor/\n')
  await folder.undo()
})

it.each(['before-check', 'at-spawn'])(
  'preserves a foreign outside worktree through a leaf symlink %s',
  async (when) => {
    await run(['branch', 'foreign'])
    const outside = join(temp, 'outside')
    const path = join(root, '.phosphor', 'worktrees', 'foreign')
    const realGit = exec.git
    const logs: unknown[] = []
    let swapped = false
    const spy = vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
      const trigger =
        when === 'before-check'
          ? args[0] === 'rev-parse' && args[1] === '--git-common-dir'
          : args[0] === 'worktree' && args[1] === 'add'
      if (trigger && !swapped) {
        swapped = true
        await realGit(root, ['worktree', 'add', outside, 'foreign'])
        symlinkSync(outside, path)
      }
      return realGit(cwd, args, options)
    })
    await expect(
      prepareLaneFolder({
        root,
        worktree: { branch: 'foreign' },
        log: (_scope, message, data) => logs.push({ message, data }),
      }),
    ).rejects.toThrow(
      when === 'before-check'
        ? 'A worktree folder for that branch already exists.'
        : 'The worktree could not be created.',
    )
    expect(existsSync(outside)).toBe(true)
    expect(await run(['worktree', 'list', '--porcelain'])).toContain(`worktree ${outside}`)
    expect(await run(['rev-parse', 'foreign'])).toBe(await run(['rev-parse', 'main']))
    expect(spy.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(
      false,
    )
    if (when === 'before-check')
      expect(spy.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'add')).toBe(
        false,
      )
    else expect(logs).toEqual([{ message: 'lane.worktree_undo_failed', data: {} }])
  },
)
it.each(['symlink', 'file'])(
  'undo refuses a replaced %s leaf before inspecting registrations',
  async (kind) => {
    const logs: unknown[] = []
    const folder = await prepareLaneFolder({
      root,
      worktree: { branch: 'replace' },
      log: (_scope, message, data) => logs.push({ message, data }),
    })
    const kept = folder.cwd + '-kept'
    renameSync(folder.cwd, kept)
    if (kind === 'symlink') symlinkSync(kept, folder.cwd)
    else writeFileSync(folder.cwd, 'private')
    const spy = vi.spyOn(exec, 'git')
    await folder.undo()
    expect(spy).not.toHaveBeenCalled()
    expect(logs).toEqual([{ message: 'lane.worktree_undo_failed', data: {} }])
    expect(existsSync(kept)).toBe(true)
    expect(await run(['rev-parse', 'replace'])).toBe(await run(['rev-parse', 'main']))
  },
)
it('undo canonicalizes only the parent, never the worktree leaf', async () => {
  const folder = await prepare('canonical-parent')
  const spy = vi.spyOn(realpathSync, 'native')
  await folder.undo()
  expect(spy).toHaveBeenCalledWith(join(root, '.phosphor', 'worktrees'))
  expect(spy).not.toHaveBeenCalledWith(folder.cwd)
  expect(existsSync(folder.cwd)).toBe(false)
})
it('refuses an append beyond the exclude cap without modifying exact-cap content', async () => {
  const exclude = join(root, '.git', 'info', 'exclude')
  const content = Buffer.alloc(1024 * 1024, '#')
  writeFileSync(exclude, content)
  await expect(prepare('append-cap')).rejects.toThrow('The worktree could not be created.')
  expect(readFileSync(exclude)).toEqual(content)
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'append-cap'))).toBe(false)
})

it('fresh refuses a laneless old branch without a folder, and a suffixed branch starts from main', async () => {
  await run(['checkout', '-b', 'phosphor/fix-bug'])
  await run(['commit', '--allow-empty', '-m', 'old unrelated work'])
  const old = await run(['rev-parse', 'HEAD'])
  await run(['checkout', 'main'])
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'phosphor/fix-bug', fresh: true } }),
  ).rejects.toMatchObject({ code: 'branch-exists' })
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'phosphor-fix-bug'))).toBe(false)
  expect(existsSync(join(root, '.phosphor'))).toBe(false)
  const next = await prepareLaneFolder({
    root,
    worktree: { branch: 'phosphor/fix-bug-2', fresh: true },
  })
  expect(await run(['rev-parse', 'phosphor/fix-bug-2'])).toBe(await run(['rev-parse', 'main']))
  expect(await run(['rev-parse', 'phosphor/fix-bug'])).toBe(old)
  await next.undo()
  expect(existsSync(next.cwd)).toBe(false)
  expect(await run(['for-each-ref', 'refs/heads/phosphor/fix-bug-2'])).toBe('')
})

it('two concurrent fresh creates never reuse the same branch', async () => {
  const realGit = exec.git
  let waiting = 0
  let release!: () => void
  const barrier = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'update-ref' && args[1] === 'refs/heads/concurrent') {
      if (++waiting === 2) release()
      await barrier
    }
    return realGit(cwd, args, options)
  })

  const results = await Promise.allSettled(
    [1, 2].map(() => prepareLaneFolder({ root, worktree: { branch: 'concurrent', fresh: true } })),
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'branch-exists' },
  })
  for (const result of results) if (result.status === 'fulfilled') await result.value.undo()
})

it('fresh refuses an unregistered leaf before reserving any ref and leaves it untouched', async () => {
  const path = join(root, '.phosphor', 'worktrees', 'occupied-leaf')
  mkdirSync(path, { recursive: true })
  writeFileSync(join(path, 'kept'), 'keep this folder')
  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'))
  const spy = vi.spyOn(exec, 'git')
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'occupied-leaf', fresh: true } }),
  ).rejects.toMatchObject({ code: 'folder-exists', message: /worktree folder .* exists/ })
  expect(spy.mock.calls.some(([, args]) => args[0] === 'update-ref')).toBe(false)
  expect(await run(['for-each-ref', 'refs/heads/occupied-leaf'])).toBe('')
  expect(readFileSync(join(path, 'kept'), 'utf8')).toBe('keep this folder')
  expect(readFileSync(join(root, '.git', 'info', 'exclude'))).toEqual(exclude)
})

it('fresh loses a branch-only reservation race without directories or exclude changes', async () => {
  const realGit = exec.git
  const base = await run(['rev-parse', 'main'])
  const excludePath = join(root, '.git', 'info', 'exclude')
  const exclude = readFileSync(excludePath)
  vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
    if (args[0] === 'update-ref' && args[1] === 'refs/heads/branch-only-race')
      await realGit(root, ['branch', 'branch-only-race', base])
    return realGit(cwd, args, options)
  })
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'branch-only-race', fresh: true } }),
  ).rejects.toMatchObject({ code: 'branch-exists' })
  expect(existsSync(join(root, '.phosphor'))).toBe(false)
  expect(readFileSync(excludePath)).toEqual(exclude)
  expect(await run(['rev-parse', 'branch-only-race'])).toBe(base)
})

it.each(['parent', 'exclude', 'leaf', 'moved'] as const)(
  'fresh rolls back its owned ref independently of a later %s failure',
  async (failure) => {
    const realGit = exec.git
    const base = await run(['rev-parse', 'main'])
    await run(['commit', '--allow-empty', '-m', 'next'])
    const next = await run(['rev-parse', 'main'])
    await run(['reset', '--hard', base])
    const path = join(root, '.phosphor', 'worktrees', 'reserved')
    const logs: unknown[] = []
    if (failure === 'exclude')
      vi.mocked(fs.openSync).mockImplementation(() => {
        throw new Error('exclude')
      })
    const spy = vi.spyOn(exec, 'git').mockImplementation(async (cwd, args, options) => {
      if (args[0] === 'update-ref' && args[1] === 'refs/heads/reserved') {
        const result = await realGit(cwd, args, options)
        if (failure === 'parent') writeFileSync(join(root, '.phosphor'), 'keep parent file')
        return result
      }
      if (args[0] === 'worktree' && args[1] === 'add') {
        mkdirSync(path)
        writeFileSync(join(path, 'kept'), 'keep unregistered leaf')
        if (failure === 'moved') await realGit(root, ['update-ref', 'refs/heads/reserved', next])
        throw new Error('add failed')
      }
      return realGit(cwd, args, options)
    })
    await expect(
      prepareLaneFolder({
        root,
        worktree: { branch: 'reserved', fresh: true },
        log: (_scope, message, data) => logs.push({ message, data }),
      }),
    ).rejects.toThrow('The worktree could not be created.')
    expect(spy).toHaveBeenCalledWith(
      root,
      ['update-ref', '-d', 'refs/heads/reserved', base],
      expect.anything(),
    )
    if (failure === 'moved') expect(await run(['rev-parse', 'reserved'])).toBe(next)
    else expect(await run(['for-each-ref', 'refs/heads/reserved'])).toBe('')
    if (failure === 'parent')
      expect(readFileSync(join(root, '.phosphor'), 'utf8')).toBe('keep parent file')
    if (failure === 'leaf' || failure === 'moved')
      expect(readFileSync(join(path, 'kept'), 'utf8')).toBe('keep unregistered leaf')
    expect(spy.mock.calls.some(([, args]) => args[0] === 'worktree' && args[1] === 'remove')).toBe(
      false,
    )
    expect(JSON.stringify(logs)).not.toContain('reserved')
  },
)

async function commitTrackedFile(): Promise<void> {
  writeFileSync(join(root, 'a.txt'), 'tracked content\n')
  await run(['add', 'a.txt'])
  await run(['commit', '-m', 'tracked base'])
}

it('fresh post-add failure removes a tracked worktree and registration before deleting its ref', async () => {
  await commitTrackedFile()
  const path = join(root, '.phosphor', 'worktrees', 'tracked-failure')
  const original = realpathSync.native
  vi.spyOn(realpathSync, 'native').mockImplementation((value) =>
    original(value) === path ? temp : original(value),
  )
  const spy = vi.spyOn(exec, 'git')
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'tracked-failure', fresh: true } }),
  ).rejects.toThrow('The worktree could not be created.')
  expect(existsSync(path)).toBe(false)
  expect(await run(['worktree', 'list', '--porcelain'])).not.toContain(path)
  expect(await run(['for-each-ref', 'refs/heads/tracked-failure'])).toBe('')
  const cleanup = spy.mock.calls
    .map(([, args]) => args)
    .filter(
      (args) =>
        (args[0] === 'worktree' && args[1] === 'remove') ||
        (args[0] === 'update-ref' && args[1] === '-d'),
    )
  expect(cleanup).toEqual([
    ['worktree', 'remove', path],
    ['update-ref', '-d', 'refs/heads/tracked-failure', await run(['rev-parse', 'main'])],
  ])
})

it('fresh remove failure surfaces the original error after guarded ref cleanup, without force', async () => {
  await commitTrackedFile()
  const logs: unknown[] = []
  const folder = await prepareLaneFolder({
    root,
    worktree: { branch: 'remove-failure', fresh: true },
    log: (_scope, message, data) => logs.push({ message, data }),
  })
  const realGit = exec.git
  const failure = new Error('private worktree removal details')
  const spy = vi
    .spyOn(exec, 'git')
    .mockImplementation((cwd, args, options) =>
      args[0] === 'worktree' && args[1] === 'remove'
        ? Promise.reject(failure)
        : realGit(cwd, args, options),
    )
  await expect(folder.undo()).rejects.toBe(failure)
  expect(await run(['for-each-ref', 'refs/heads/remove-failure'])).toBe('')
  expect(existsSync(folder.cwd)).toBe(true)
  expect(await run(['worktree', 'list', '--porcelain'])).toContain(folder.cwd)
  expect(spy.mock.calls.some(([, args]) => args.includes('--force'))).toBe(false)
  expect(logs).toEqual([{ message: 'lane.worktree_undo_failed', data: {} }])
})

it('fresh tracked-worktree cleanup preserves a ref moved by another creator', async () => {
  await commitTrackedFile()
  const folder = await prepareLaneFolder({
    root,
    worktree: { branch: 'tracked-moved', fresh: true },
  })
  await run(['commit', '--allow-empty', '-m', 'next'])
  const next = await run(['rev-parse', 'main'])
  await run(['update-ref', 'refs/heads/tracked-moved', next])
  await folder.undo()
  expect(existsSync(folder.cwd)).toBe(false)
  expect(await run(['worktree', 'list', '--porcelain'])).not.toContain(folder.cwd)
  expect(await run(['rev-parse', 'tracked-moved'])).toBe(next)
})

async function originDevelop(): Promise<{ origin: string; local: string }> {
  await run(['checkout', '-b', 'develop'])
  await run(['commit', '--allow-empty', '-m', 'develop'])
  const remote = join(temp, 'origin.git')
  await run(['init', '--bare', remote])
  await run(['remote', 'add', 'origin', remote])
  await run(['push', 'origin', 'develop'])
  await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop'])
  const origin = await run(['rev-parse', 'refs/remotes/origin/develop'])
  await run(['commit', '--allow-empty', '-m', 'local develop only'])
  await run(['checkout', 'main'])
  await run(['branch', 'master', 'develop'])
  return { origin, local: await run(['rev-parse', 'develop']) }
}

it('origin/HEAD outranks local main, master and the current branch for base and default refusal', async () => {
  const { origin, local } = await originDevelop()
  await expect(prepare('develop')).rejects.toThrow('The default branch stays in the main tree.')
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'develop', fresh: true } }),
  ).rejects.toMatchObject({ code: 'branch-exists' })
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'develop'))).toBe(false)
  const lane = await prepareLaneFolder({ root, worktree: { branch: 'lane', fresh: true } })
  expect(await run(['rev-parse', 'lane'])).toBe(origin)
  const master = await prepare('master')
  expect(await run(['symbolic-ref', '--short', 'HEAD'], master.cwd)).toBe('master')
  await master.undo()
  expect(await run(['rev-parse', 'master'])).toBe(local)
  await lane.undo()
  expect(await run(['for-each-ref', 'refs/heads/lane'])).toBe('')
  expect(await run(['rev-parse', 'develop'])).toBe(local)
})

it('without origin/HEAD, main outranks master and the current branch', async () => {
  const main = await run(['rev-parse', 'main'])
  await run(['checkout', '-b', 'master'])
  await run(['commit', '--allow-empty', '-m', 'master'])
  await run(['checkout', '-b', 'current'])
  await run(['commit', '--allow-empty', '-m', 'current'])
  await expect(prepare('main')).rejects.toThrow('The default branch stays in the main tree.')
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'main', fresh: true } }),
  ).rejects.toMatchObject({ code: 'branch-exists' })
  const lane = await prepare('from-main')
  expect(await run(['rev-parse', 'from-main'])).toBe(main)
  const master = await prepare('master')
  await master.undo()
  await lane.undo()
  expect(await run(['for-each-ref', 'refs/heads/from-main'])).toBe('')
})

it('fresh rollback after an origin-based reservation deletes only its own ref', async () => {
  const { origin, local } = await originDevelop()
  const realGit = exec.git
  vi.spyOn(exec, 'git').mockImplementation((cwd, args, options) =>
    args[0] === 'worktree' && args[1] === 'add'
      ? Promise.reject(new Error('add failed'))
      : realGit(cwd, args, options),
  )
  await expect(
    prepareLaneFolder({ root, worktree: { branch: 'origin-rollback', fresh: true } }),
  ).rejects.toEqual(new LaneFolderError('The worktree could not be created.'))
  vi.restoreAllMocks()
  expect(await run(['for-each-ref', 'refs/heads/origin-rollback'])).toBe('')
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'origin-rollback'))).toBe(false)
  expect(await run(['rev-parse', 'refs/remotes/origin/develop'])).toBe(origin)
  expect(await run(['rev-parse', 'develop'])).toBe(local)
})

it('a detached HEAD without trunk candidates creates from the HEAD commit and allows its branch', async () => {
  await run(['branch', '-m', 'trunk'])
  await run(['commit', '--allow-empty', '-m', 'detached'])
  await run(['checkout', '--detach'])
  await run(['update-ref', 'refs/heads/trunk', 'HEAD~1'])
  const head = await run(['rev-parse', 'HEAD'])
  const lane = await prepareLaneFolder({ root, worktree: { branch: 'detached', fresh: true } })
  expect(await run(['rev-parse', 'detached'])).toBe(head)
  const trunk = await prepare('trunk')
  await trunk.undo()
  await lane.undo()
  expect(await run(['for-each-ref', 'refs/heads/detached'])).toBe('')
})

it('an unborn HEAD without trunk candidates refuses new branches with the generic sentence', async () => {
  await run(['branch', '-m', 'trunk'])
  await run(['checkout', '--orphan', 'unborn'])
  for (const fresh of [true, undefined] as const)
    await expect(
      prepareLaneFolder({ root, worktree: { branch: 'orphan-lane', ...(fresh && { fresh }) } }),
    ).rejects.toEqual(new LaneFolderError('The worktree could not be created.'))
  expect(await run(['for-each-ref', 'refs/heads/orphan-lane'])).toBe('')
  expect(existsSync(join(root, '.phosphor', 'worktrees', 'orphan-lane'))).toBe(false)
})

it('a develop-only lane is created from and later proven against the same trunk', async () => {
  await run(['branch', '-m', 'develop'])
  await run(['commit', '--allow-empty', '-m', 'develop'])
  const develop = await run(['rev-parse', 'develop'])
  const lane = await prepareLaneFolder({ root, worktree: { branch: 'phosphor/lane', fresh: true } })
  expect(await run(['rev-parse', 'phosphor/lane'])).toBe(develop)
  await run(['commit', '--allow-empty', '-m', 'lane work'], lane.cwd)
  await run(['worktree', 'remove', lane.cwd])
  expect(await deleteMergedBranch(root, 'phosphor/lane')).toBe(false)
  await run(['merge', '--no-ff', '-m', 'merge lane', 'phosphor/lane'])
  expect(await deleteMergedBranch(root, 'phosphor/lane')).toBe(true)
  expect(await run(['for-each-ref', 'refs/heads/phosphor/lane'])).toBe('')
})

it('a lane created without a trunk ref falls back to the HEAD commit and is never proven merged', async () => {
  await run(['branch', '-m', 'trunk'])
  await run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/missing'])
  const lane = await prepareLaneFolder({ root, worktree: { branch: 'no-trunk', fresh: true } })
  const head = await run(['rev-parse', 'HEAD'])
  expect(await run(['rev-parse', 'no-trunk'])).toBe(head)
  await run(['worktree', 'remove', lane.cwd])
  expect(await branchMerged(root, 'no-trunk')).toBe(false)
  expect(await deleteMergedBranch(root, 'no-trunk')).toBe(false)
  await run(['symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'])
  await run(['checkout', '--detach'])
  expect(await branchMerged(root, 'no-trunk')).toBe(false)
  expect(await run(['rev-parse', 'no-trunk'])).toBe(head)
})

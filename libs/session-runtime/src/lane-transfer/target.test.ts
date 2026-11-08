import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaneSourceFacts } from '@phosphor/shared/host-protocol-lane-transfer'
import { inspectSourceGit, normalizeOrigin } from './source-git'
import { inspectTargetGit, planMove, prepareTarget, type WorktreePort } from './target'

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim()

/** A bare origin, a source clone with a lane worktree, and a second clone as the target. */
function repositories() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), 'lane-git-')))
  const origin = join(temp, 'origin.git')
  sh(temp, 'init', '--bare', '-b', 'main', origin)
  const source = join(temp, 'source')
  sh(temp, 'clone', origin, source)
  // Both clones name origin by a URL, as real ones do; insteadOf sends it to the folder.
  const named = (clone: string) => {
    sh(clone, 'config', `url.${origin}.insteadOf`, 'https://example.test/o/r')
    sh(clone, 'remote', 'set-url', 'origin', 'https://example.test/o/r')
  }
  named(source)
  writeFileSync(join(source, 'a.txt'), 'a')
  sh(source, 'add', '.')
  sh(source, 'commit', '-m', 'one')
  sh(source, 'push', 'origin', 'main')
  const lane = join(source, '.phosphor', 'worktrees', 'feature')
  sh(source, 'worktree', 'add', '-b', 'phosphor/feature', lane)
  writeFileSync(join(lane, 'b.txt'), 'b')
  sh(lane, 'add', '.')
  sh(lane, 'commit', '-m', 'two')
  const target = join(temp, 'target')
  sh(temp, 'clone', origin, target)
  named(target)
  return { temp, origin, source, lane, target }
}

const worktrees: WorktreePort = {
  async add(root, branch, fresh) {
    const path = join(root, '.phosphor', 'worktrees', branch.replaceAll('/', '-'))
    mkdirSync(join(root, '.phosphor', 'worktrees'), { recursive: true })
    sh(root, 'worktree', 'add', ...(fresh ? ['-b', branch, path, 'origin/main'] : [path, branch]))
    return { cwd: realpathSync(path), undo: async () => void sh(root, 'worktree', 'remove', path) }
  },
}

async function facts(cwd: string): Promise<LaneSourceFacts> {
  const git = await inspectSourceGit(cwd)
  if (git.kind !== 'git') throw new Error('not git')
  return {
    sessionId: '01a1b11c-7705-7534-964e-c100db3101ce',
    title: 'Fix It',
    workspace: 'source',
    cwd,
    git: git.facts,
    bytes: 1,
    transcriptBytes: 1,
  }
}

const plan = (
  source: LaneSourceFacts,
  root: string,
  target: Awaited<ReturnType<typeof inspectTargetGit>>,
) =>
  planMove({
    source,
    target,
    root,
    workspace: 'target',
    branchPrefix: 'phosphor/',
    sameMachine: false,
  })

describe('a lane in the same repository on another machine', () => {
  it('refuses until the branch is pushed, then checks it out at the same commit', async () => {
    const { lane, target } = repositories()
    let source = await facts(lane)
    const remote = await inspectTargetGit(target)
    expect(plan(source, target, remote).blockers).toEqual([
      'Push phosphor/feature to origin first. Its exact commit must be on origin.',
    ])
    sh(lane, 'push', 'origin', 'phosphor/feature')
    source = await facts(lane)
    const ready = plan(source, target, remote)
    expect(ready).toMatchObject({
      mode: 'same-workspace',
      branch: 'phosphor/feature',
      blockers: [],
    })
    const folder = await prepareTarget({ plan: ready, root: target, source, worktrees })
    expect(sh(folder.cwd, 'rev-parse', 'HEAD')).toBe(source.git!.commit)
    // A second lane from the same worktree shares the folder rather than failing.
    const again = await prepareTarget({ plan: ready, root: target, source, worktrees })
    expect(again.cwd).toBe(folder.cwd)
    await folder.undo()
    expect(sh(target, 'branch', '--list', 'phosphor/feature')).toBe('')
  })

  it('refuses uncommitted work, and a target branch of that name at another commit', async () => {
    const { lane, target } = repositories()
    sh(lane, 'push', 'origin', 'phosphor/feature')
    writeFileSync(join(lane, 'untracked.txt'), 'x')
    const dirty = await facts(lane)
    expect(plan(dirty, target, await inspectTargetGit(target)).blockers[0]).toMatch(
      /uncommitted changes/,
    )
    sh(lane, 'clean', '-fd')
    const clean = await facts(lane)
    sh(target, 'branch', 'phosphor/feature', 'main')
    const ready = plan(clean, target, await inspectTargetGit(target))
    await expect(
      prepareTarget({ plan: ready, root: target, source: clean, worktrees }),
    ).rejects.toThrow('target has its own phosphor/feature at another commit.')
  })

  it('refuses the default branch and the same machine', async () => {
    const { source, lane, target } = repositories()
    const trunk = await facts(source)
    expect(plan(trunk, target, await inspectTargetGit(target)).blockers).toContain(
      'This lane is on the default branch, which stays in the main checkout.',
    )
    const same = planMove({
      source: await facts(lane),
      target: await inspectTargetGit(target),
      root: target,
      workspace: 't',
      branchPrefix: '',
      sameMachine: true,
    })
    expect(same.blockers).toContain(
      'This lane is already in this repository on this machine. Use Clone instead.',
    )
  })
})

describe('a lane moving to another repository or a plain folder', () => {
  it('gets a fresh branch of its own name, refused when that name is taken', async () => {
    const { lane, temp } = repositories()
    const other = join(temp, 'other')
    sh(temp, 'init', '-b', 'main', other)
    writeFileSync(join(other, 'x'), 'x')
    sh(other, 'add', '.')
    sh(other, 'commit', '-m', 'x')
    sh(other, 'remote', 'add', 'origin', 'git@github.com:someone/else.git')
    const source = await facts(lane)
    const ready = plan(source, other, await inspectTargetGit(other))
    expect(ready).toMatchObject({ mode: 'new-branch', branch: 'phosphor/feature', blockers: [] })
    sh(other, 'branch', 'phosphor/feature')
    await expect(prepareTarget({ plan: ready, root: other, source, worktrees })).rejects.toThrow(
      'A branch named phosphor/feature already exists in target.',
    )
  })

  it('names a branch from the title when the lane had none', async () => {
    const { temp, target } = repositories()
    const folder: LaneSourceFacts = {
      sessionId: '01a1b11c-7705-7534-964e-c100db3101ce',
      title: 'Fix It',
      workspace: 'scratch',
      cwd: temp,
      git: null,
      bytes: 1,
      transcriptBytes: 1,
    }
    expect(plan(folder, target, await inspectTargetGit(target))).toMatchObject({
      mode: 'new-branch',
      branch: 'phosphor/fix-it',
    })
    expect(plan(folder, temp, { kind: 'folder' })).toMatchObject({
      mode: 'folder',
      branch: null,
      blockers: [],
    })
  })
})

it('refuses detached/default-branch sources and detects merge state in a worktree', async () => {
  const { source, lane } = repositories()
  const trunk = await inspectSourceGit(source)
  expect(trunk.kind === 'git' && trunk.blockers.join(' ')).toContain('default branch')
  sh(lane, 'checkout', '--detach')
  const detached = await inspectSourceGit(lane)
  expect(detached.kind === 'git' && detached.blockers.join(' ')).toContain('detached HEAD')
  sh(lane, 'checkout', 'phosphor/feature')
  const merge = sh(lane, 'rev-parse', '--git-path', 'MERGE_HEAD')
  writeFileSync(merge, sh(lane, 'rev-parse', 'HEAD') + '\n')
  const merging = await inspectSourceGit(lane)
  expect(merging.kind === 'git' && merging.blockers.join(' ')).toContain(
    'merge, rebase or cherry-pick',
  )
})

it('normalizes the spellings of one origin and nothing else', () => {
  const one = 'github.com/owner/repo'
  expect(normalizeOrigin('git@github.com:Owner/Repo.git')).toBe(one)
  expect(normalizeOrigin('https://github.com/owner/repo')).toBe(one)
  expect(normalizeOrigin('ssh://git@github.com/owner/repo.git')).toBe(one)
  expect(normalizeOrigin('/srv/repo.git')).toBeNull()
  expect(normalizeOrigin('file:///srv/owner/repo')).toBeNull()
})

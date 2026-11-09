import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { expect, it } from 'vitest'
import { laneMetadata, projectContext, readLane } from './lane'
import { LANE_ENTRIES } from './__fixtures__/lane'

it('reads session identity, last model, thinking and leaf without confusing summaries with messages', () => {
  expect(laneMetadata(LANE_ENTRIES)).toEqual({
    sessionId: 'harbor-lane',
    cwd: '/projects/harbor',
    model: 'example/fast',
    thinking: 'high',
    leafId: 'custom',
  })
  expect(
    laneMetadata([
      ...LANE_ENTRIES,
      { type: 'model_change', id: 'new-model', provider: 'other', modelId: 'quick' },
    ]).model,
  ).toBe('other/quick')
  expect(laneMetadata(LANE_ENTRIES.filter((e) => e.type !== 'model_change')).model).toBe(
    'example/fast',
  )
  expect(
    laneMetadata([
      ...LANE_ENTRIES,
      { type: 'message', message: { role: 'assistant', provider: 'stale', model: 'old' } },
    ]).model,
  ).toBe('example/fast')
  expect(() => laneMetadata([])).toThrow(/header/)
  expect(() => laneMetadata([LANE_ENTRIES[0]!])).toThrow(/model/)
})

it('uses the common git root for worktrees, branch null when detached, and cwd outside git', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'harbor-lane-'))
  const root = join(await realpath(directory), 'harbor')
  const worktree = join(directory, 'billing')
  await mkdir(root)
  try {
    await git(root, ['init', '-b', 'main'])
    await git(root, [
      '-c',
      'user.name=Tom Lee',
      '-c',
      'user.email=tom@example.test',
      'commit',
      '--allow-empty',
      '-m',
      'Harbor',
    ])
    await git(root, ['worktree', 'add', '-b', 'billing', worktree])
    expect(await projectContext(worktree)).toEqual({ scope: root, branch: 'billing' })
    await git(worktree, ['checkout', '--detach'])
    expect(await projectContext(worktree)).toEqual({ scope: root, branch: null })
    expect(await projectContext(directory)).toEqual({ scope: directory, branch: null })
    const session = join(directory, 'session.jsonl')
    await writeFile(session, LANE_ENTRIES.map((entry) => JSON.stringify(entry)).join('\n'))
    expect(await readLane(session)).toMatchObject({
      scope: '/projects/harbor',
      branch: null,
      model: 'example/fast',
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { isLaneBranchName, parseClientFrame, parseHostFrame } from './host-protocol'

it('the d7bc0e68 Host lane.create validator accepts and strips fresh instead of rejecting it', () => {
  // Exact lane.create switch arm from d7bc0e68, with its primitive guards supplied below.
  const arm = readFileSync(
    new URL('./__fixtures__/lane-create-d7bc0e68.txt', import.meta.url),
    'utf8',
  )
  const legacy = new Function(
    'v',
    'record',
    'isLaneBranchName',
    'hex',
    'label',
    'text',
    'member',
    'thinking',
    `switch (v.type) { ${arm} }`,
  )
  const op = {
    type: 'lane.create',
    repositoryId: '0123456789abcdef',
    worktree: { branch: 'feature', fresh: true },
  }
  const parsed: unknown = legacy(
    op,
    (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v),
    isLaneBranchName,
    (v: unknown) => typeof v === 'string' && /^[0-9a-f]{16}$/.test(v),
    () => false,
    () => false,
    () => false,
    [],
  )
  expect(parsed).toEqual({ ...op, worktree: { branch: 'feature' } })
  expect(
    parseClientFrame(
      JSON.stringify({ type: 'command', requestId: '00000000-0000-4000-8000-000000000001', op }),
    ),
  ).toMatchObject({ ok: true, frame: { op } })
  for (const fresh of [false, null, 1, 'true']) {
    expect(
      parseClientFrame(
        JSON.stringify({
          type: 'command',
          requestId: '00000000-0000-4000-8000-000000000001',
          op: { ...op, worktree: { branch: 'feature', fresh } },
        }),
      ).ok,
    ).toBe(false)
  }
})
it('retains every old rejection code and adds branch-exists', () => {
  for (const code of [
    'bad-request',
    'unsupported',
    'forbidden',
    'unknown-lane',
    'lane-stopped',
    'not-controller',
    'stale-fence',
    'conflict',
    'busy',
    'last-repository',
    'too-many-requests',
    'branch-exists',
  ]) {
    expect(
      parseHostFrame(
        JSON.stringify({
          type: 'receipt',
          receipt: { requestId: '00000000-0000-4000-8000-000000000001', status: 'rejected', code },
        }),
      ).ok,
    ).toBe(true)
  }
})

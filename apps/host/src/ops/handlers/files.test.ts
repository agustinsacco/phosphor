import { expect, it, vi } from 'vitest'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { fileHandlers } from './files'
import { gitHandlers } from './git'
import type { DaemonHandlerDeps } from './index'

const lane = { ref: 'host:h1/lane:L1', sessionId: null, title: 'L', cwd: '/w', busy: false }
const ctx = (over: Partial<OpHandlerContext> = {}) =>
  ({ principal: { kind: 'local', clientId: 'cli' }, lane, log: () => {}, ...over }) as never

function harness() {
  const call = vi.fn(async (method: string, _params: unknown) => {
    if (method === 'files.list')
      return { ok: true, data: { files: ['a.ts', 'src/b.ts', 'src2/c'] } }
    if (method === 'files.read')
      return { ok: true, data: { binary: false, size: 2, content: 'hi', revision: 'r1' } }
    return { ok: true, data: { method } }
  })
  const execute = vi.fn(async () => ({ ok: true as const }))
  const summary = { cwd: '/w', branch: 'main', worktree: false, repositoryId: 'a'.repeat(16) }
  const deps = {
    lanes: { calls: { call } },
    writes: { execute },
    laneRuntime: { summaryFor: () => summary },
  } as unknown as DaemonHandlerDeps
  return { files: fileHandlers(deps), git: gitHandlers(deps), call, execute }
}

it('lists only the files under the path, and reads a file’s text', async () => {
  const h = harness()
  expect((await h.files['files.list']!({ path: 'src' }, ctx())).data).toEqual(['src/b.ts'])
  expect((await h.files['files.list']!({ path: '.' }, ctx())).data).toHaveLength(3)
  expect(h.call).toHaveBeenCalledWith('files.list', { laneId: 'L1' })
  expect(await h.files['files.read']!({ path: 'a.ts' }, ctx())).toMatchObject({
    text: 'hi',
    data: { revision: 'r1' },
  })
})

it('maps each write to the Host’s own file op on the target lane', async () => {
  const h = harness()
  await h.files['files.write']!({ path: 'a', content: 'x', expected: 'r1' }, ctx())
  await h.files['files.create']!({ path: 'b', content: 'y' }, ctx())
  await h.files['files.create']!({ path: 'c' }, ctx())
  await h.files['files.mkdir']!({ path: 'd' }, ctx())
  await h.files['files.trash']!({ path: 'e' }, ctx())
  await h.files['files.rename']!({ from: 'f', to: 'g' }, ctx())
  await h.files['files.transfer']!({ source: 'h', directory: 'i', mode: 'copy' }, ctx())
  expect(h.execute.mock.calls).toEqual([
    ['L1', { type: 'files.write', path: 'a', content: 'x', expected: 'r1' }],
    ['L1', { type: 'files.write', path: 'b', content: 'y', expected: null }],
    ['L1', { type: 'files.create', path: 'c', kind: 'file' }],
    ['L1', { type: 'files.create', path: 'd', kind: 'directory' }],
    ['L1', { type: 'files.delete', path: 'e' }],
    ['L1', { type: 'files.rename', from: 'f', to: 'g' }],
    ['L1', { type: 'files.transfer', source: 'h', directory: 'i', mode: 'copy' }],
  ])
})

it('answers a Host refusal in band and needs a lane', async () => {
  const h = harness()
  h.execute.mockResolvedValueOnce({ ok: false, code: 'conflict' } as never)
  await expect(
    h.files['files.write']!({ path: 'a', content: 'x', expected: null }, ctx()),
  ).rejects.toMatchObject({
    code: 'bad-request',
    message: expect.stringContaining('read it again'),
  })
  h.call.mockResolvedValueOnce({
    ok: false,
    error: { code: 'unknown-lane', message: 'x' },
  } as never)
  await expect(h.files['files.read']!({ path: 'a' }, ctx())).rejects.toMatchObject({
    code: 'bad-request',
    message: 'No such lane on this machine.',
  })
  await expect(
    h.files['files.list']!({ path: '.' }, ctx({ lane: undefined })),
  ).rejects.toMatchObject({ code: 'bad-request' })
})

it('reads git and PR status through the Host’s git and GitHub features', async () => {
  const h = harness()
  expect((await h.git['git.info']!({}, ctx())).data).toEqual({
    cwd: '/w',
    branch: 'main',
    worktree: false,
    repositoryId: 'a'.repeat(16),
  })
  await h.git['git.status']!({}, ctx())
  await h.git['git.show']!({ ref: 'HEAD', path: 'a' }, ctx())
  await h.git['pr.list']!({}, ctx())
  const url = 'https://github.com/o/r/pull/7'
  await h.git['pr.status']!({ refs: [url] }, ctx())
  await h.git['pr.detail']!({ ref: url }, ctx())
  const pr = { host: 'github.com', owner: 'o', repo: 'r', number: 7 }
  expect(h.call.mock.calls).toEqual([
    ['git.status', { laneId: 'L1' }],
    ['git.show', { laneId: 'L1', path: 'a', ref: 'HEAD' }],
    ['github.prs', { repositoryId: 'a'.repeat(16) }],
    ['github.prSummaries', { refs: [pr], options: {} }],
    ['github.prDetail', { ref: pr, options: {} }],
  ])
  await expect(h.git['pr.detail']!({ ref: 'seven' }, ctx())).rejects.toMatchObject({
    code: 'bad-request',
  })
})

it('pages literal workspace search through the lane file owner', async () => {
  const h = harness()
  h.call.mockResolvedValueOnce({
    ok: true,
    data: [
      { path: 'a.ts', line: 1, snippet: 'a+b' },
      { path: 'b.ts', line: 2, snippet: 'a+b' },
    ],
  } as never)
  const page = await h.files['files.search']!({ query: 'a+b' }, ctx({ limit: 1 }))
  expect(page).toMatchObject({
    text: 'path | line | snippet\na.ts | 1 | a+b',
    next: expect.any(String),
  })
  expect(h.call).toHaveBeenCalledWith('files.search', { laneId: 'L1', query: 'a+b' })
  expect(h.execute).not.toHaveBeenCalled()
})

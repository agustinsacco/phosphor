import { beforeEach, expect, it, vi } from 'vitest'
import { prKey } from '@phosphor/shared/github-pr-refs'
import { HOST_CAPABILITIES } from '@phosphor/shared/remote-host'
import type { FeatureContext } from '../feature'

const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@phosphor/session-runtime/git/github-command', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runGithubCommand: run,
}))
import { createGitFeature } from '../git'

const ref = { host: 'github.com', owner: 'acme', repo: 'app', number: 57 }
const context: FeatureContext = {
  store: { getLane: () => null, listRepositories: () => [] },
  env: { PATH: '/host/bin' },
  home: '/host/home',
  log: vi.fn(),
}

beforeEach(() => {
  run.mockReset()
})

it('serves PR status and detail by number under workspaces.read, like github.prs', () => {
  const feature = createGitFeature(context)
  expect(feature.capability).toBe('workspaces.read')
  expect(HOST_CAPABILITIES).toContain(feature.capability)
  expect(feature.methods).toEqual(
    expect.arrayContaining(['github.prs', 'github.prSummaries', 'github.prDetail']),
  )
})

it('refuses malformed params before running gh', async () => {
  const feature = createGitFeature(context)
  for (const params of [
    undefined,
    { refs: [] },
    { refs: [{ ...ref, host: 'evil host' }] },
    { refs: [ref], path: '/elsewhere' },
    { refs: [ref], options: { force: 'yes' } },
  ])
    expect(await feature.call('github.prSummaries', params), JSON.stringify(params)).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  for (const params of [undefined, { ref: [ref] }, { ref, refs: [ref] }, { ref: { ...ref, x: 1 } }])
    expect(await feature.call('github.prDetail', params), JSON.stringify(params)).toMatchObject({
      ok: false,
      error: { code: 'bad-request' },
    })
  expect(run).not.toHaveBeenCalled()
})

it('runs gh in the Host home and answers the shapes This Mac reads', async () => {
  run.mockResolvedValue({ ok: false, reason: 'unavailable' })
  const feature = createGitFeature(context)
  const read = await feature.call('github.prSummaries', { refs: [ref] })
  expect(read).toMatchObject({
    ok: true,
    data: { byKey: {}, coverage: { [prKey(ref)]: { state: 'unavailable' } } },
  })
  expect(run).toHaveBeenCalledWith(
    '/host/home',
    expect.arrayContaining(['api', 'graphql', '--hostname', 'github.com']),
    context.env,
    expect.any(AbortSignal),
  )
  expect(await feature.call('github.prDetail', { ref, options: { force: true } })).toEqual({
    ok: true,
    data: null,
  })
})

it('pauses status and detail together when GitHub rate-limits either', async () => {
  run.mockResolvedValue({ ok: false, reason: 'rate-limited', retryAfterMs: 60_000 })
  const feature = createGitFeature(context)
  const read = await feature.call('github.prSummaries', { refs: [ref] })
  expect(read).toMatchObject({
    ok: true,
    data: { coverage: { [prKey(ref)]: { state: 'unavailable', reason: 'rate-limited' } } },
  })
  const calls = run.mock.calls.length
  await feature.call('github.prDetail', { ref })
  await feature.call('github.prSummaries', { refs: [{ ...ref, number: 58 }] })
  expect(run).toHaveBeenCalledTimes(calls)
})

it('keeps one gate per Host feature: separate features never share a pause', async () => {
  run.mockResolvedValue({ ok: false, reason: 'rate-limited', retryAfterMs: 60_000 })
  await createGitFeature(context).call('github.prSummaries', { refs: [ref] })
  const calls = run.mock.calls.length
  await createGitFeature(context).call('github.prDetail', { ref })
  expect(run.mock.calls.length).toBeGreaterThan(calls)
})

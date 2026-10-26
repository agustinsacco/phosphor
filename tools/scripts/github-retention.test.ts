import { existsSync, readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'

const workflow = (name: string) =>
  readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), 'utf8')
const cleanup = workflow('cleanup-pr-caches')
const scriptBlock = cleanup.split('          script: |\n')[1]
if (scriptBlock === undefined) throw new Error('Missing cache cleanup script block')
const script = scriptBlock
  .split('\n')
  .map((line) => line.slice(12))
  .join('\n')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor
const clean = new AsyncFunction('context', 'github', script)
const context = { repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 7 } } }

function api(caches: { id: number; ref: string }[] = []) {
  const actions = {
    getActionsCacheList: vi.fn(),
    deleteActionsCacheById: vi.fn(async (_request: unknown) => {}),
  }
  return {
    rest: { actions },
    paginate: vi.fn(async (_method: unknown, request: { ref: string }) =>
      caches.filter((cache) => cache.ref === request.ref),
    ),
  }
}

it('deletes only the closed PR synthetic refs, including every paginated result', async () => {
  const caches = Array.from({ length: 105 }, (_, id) => ({ id, ref: 'refs/pull/7/merge' })).concat([
    { id: 200, ref: 'refs/pull/7/head' },
    { id: 201, ref: 'refs/heads/main' },
    { id: 202, ref: 'refs/pull/8/merge' },
    { id: 203, ref: 'refs/heads/feature' },
  ])
  const github = api(caches)
  await clean(context, github)
  expect(github.paginate).toHaveBeenCalledTimes(2)
  expect(github.paginate).toHaveBeenCalledWith(github.rest.actions.getActionsCacheList, {
    ...context.repo,
    ref: 'refs/pull/7/merge',
    per_page: 100,
  })
  expect(github.rest.actions.deleteActionsCacheById.mock.calls.map(([request]) => request)).toEqual(
    caches.slice(0, 106).map((cache) => ({ ...context.repo, cache_id: cache.id })),
  )
})

it('rejects unexpected refs and invalid PR identities before deleting', async () => {
  const github = api()
  github.paginate.mockResolvedValueOnce([{ id: 1, ref: 'refs/heads/main' }])
  await expect(clean(context, github)).rejects.toThrow('Unexpected cache ref')
  for (const number of [0, -1, '7', null])
    await expect(
      clean({ ...context, payload: { pull_request: { number } } }, github),
    ).rejects.toThrow('Invalid PR number')
  expect(github.rest.actions.deleteActionsCacheById).not.toHaveBeenCalled()
})

it('tolerates concurrent eviction but surfaces permission and service failures', async () => {
  for (const status of [404, 403, 500]) {
    const github = api([{ id: 1, ref: 'refs/pull/7/merge' }])
    github.rest.actions.deleteActionsCacheById.mockRejectedValueOnce({ status })
    if (status === 404) await expect(clean(context, github)).resolves.toBeUndefined()
    else await expect(clean(context, github)).rejects.toEqual({ status })
  }
})

it('never executes untrusted PR content in the privileged close hook', () => {
  expect(cleanup).toContain('pull_request_target:\n    types: [closed]')
  expect(cleanup).toContain('contents: read\n  actions: write')
  expect(cleanup).toContain('timeout-minutes: 5')
  expect(cleanup.match(/uses:/g)).toHaveLength(1)
  expect(cleanup).toContain('uses: actions/github-script@v7')
  expect(cleanup).not.toMatch(
    /actions\/checkout|\brun:|secrets\.|pull_request\.head|\$\{\{[^\n]*\}\}[^\n]*script/,
  )
})

it('keeps optional CI evidence short-lived without removing smoke tests or failure traces', () => {
  const ci = workflow('ci')
  expect(
    ci.match(
      /if: failure\(\) \|\| contains\(github.event.pull_request.labels.\*.name, 'keep-ci-artifacts'\)/g,
    ),
  ).toHaveLength(1)
  expect(ci.match(/retention-days: 3/g)).toHaveLength(1)
  expect(ci).toContain('name: CI result')
  expect(ci).toContain('name: playwright-report-${{ matrix.os }}-${{ strategy.job-index }}')
  expect(ci).toContain('retention-days: 7')
  expect(workflow('deploy-site')).toContain('DOCKER_BUILD_RECORD_RETENTION_DAYS: 3')
  expect(existsSync(new URL('../../.github/workflows/release.yml', import.meta.url))).toBe(false)
})

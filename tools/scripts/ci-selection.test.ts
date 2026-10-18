import { execFileSync } from 'node:child_process'
import { globSync, readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ALL_PROJECTS, shadowSelection } from './ci-selection.mjs'

const root = resolve(import.meta.dirname, '../..')
const repository = { full_name: 'owner/repo' }
const dir = mkdtempSync(join(tmpdir(), 'ci-selection-'))
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim()
let base: string, failed: string, head: string
const context = () => ({
  repo: { owner: 'owner', repo: 'repo' },
  sha: head,
  runId: 4,
  eventName: 'push',
  payload: { repository, ref: 'refs/heads/main', after: head },
})
const run = (head_sha: string, extra = {}) => ({
  id: 1,
  workflow_id: 10,
  head_repository: repository,
  head_branch: 'main',
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  head_sha,
  ...extra,
})
const api = (runs = [run(base)]) => ({
  rest: {
    actions: {
      getWorkflow: vi.fn(async () => ({ data: { id: 10 } })),
      listWorkflowRuns: vi.fn(async () => ({ data: { workflow_runs: runs } })),
    },
  },
})
const execute = (command: string, args: string[]) => (command === 'git' ? git(...args) : '[]')
const prContext = () => ({
  ...context(),
  eventName: 'pull_request',
  payload: {
    repository,
    pull_request: {
      base: { sha: base, ref: 'main', repo: repository },
      head: { sha: head, repo: repository },
    },
  },
})

beforeAll(() => {
  git('init', '-q')
  git('config', 'user.email', 'fixture@example.invalid')
  git('config', 'user.name', 'Fixture')
  for (const value of ['base', 'failed', 'head']) {
    writeFileSync(join(dir, 'input'), value)
    git('add', '.')
    git('commit', '-qm', value)
    if (value === 'base') base = git('rev-parse', 'HEAD')
    if (value === 'failed') failed = git('rev-parse', 'HEAD')
  }
  head = git('rev-parse', 'HEAD')
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('shadow baseline and fallback contract', () => {
  it('recovers from failed main using successful relevant CI history and actual HEAD', async () => {
    const github = api([
      run(failed, { conclusion: 'failure' }),
      run(head, { id: 4 }),
      run(failed, { workflow_id: 11 }),
      run(failed, { head_repository: { full_name: 'fork/repo' } }),
      run(failed, { status: 'in_progress' }),
      run(failed, { event: 'pull_request' }),
      run(base),
    ])
    const query = vi.fn(execute)
    expect(await shadowSelection(context(), github, query)).toMatchObject({
      mode: 'shadow',
      base,
      head,
      projects: [],
    })
    expect(query.mock.calls.at(-1)?.[1]).toContain(`--head=${head}`)
    expect(query.mock.calls.at(-1)?.[1]).toContain(`--base=${base}`)
  })
  it('verifies same-repository PR base and head ancestry', async () => {
    expect(await shadowSelection(prContext(), api(), execute)).toMatchObject({
      mode: 'shadow',
      base,
      head,
    })
  })
  it.each([
    'fork',
    'missing-base',
    'missing-head',
    'merge-group',
    'unknown',
    'bad-checkout',
    'bad-repository',
    'bad-push',
    'non-main',
  ])('%s falls back to all projects', async (fixture) => {
    const c = prContext()
    if (fixture === 'fork') c.payload.pull_request.head.repo = { full_name: 'fork/repo' }
    if (fixture === 'missing-base') c.payload.pull_request.base.sha = 'a'.repeat(40)
    if (fixture === 'missing-head') c.payload.pull_request.head.sha = 'b'.repeat(40)
    if (fixture === 'merge-group') c.eventName = 'merge_group'
    if (fixture === 'unknown') c.eventName = 'workflow_dispatch'
    if (fixture === 'bad-checkout') c.sha = base
    if (fixture === 'bad-repository') c.payload.repository = { full_name: 'other/repo' }
    if (fixture === 'bad-push')
      Object.assign(c, { eventName: 'push', payload: { ...context().payload, after: base } })
    if (fixture === 'non-main') c.payload.pull_request.base.ref = 'topic'
    expect(await shadowSelection(c, api(), execute)).toMatchObject({
      mode: 'full',
      projects: ALL_PROJECTS,
    })
  })
  it.each(['shallow', 'git-error', 'nx-error', 'nx-invalid', 'nx-parse'])(
    '%s fails safely',
    async (fixture) => {
      const query = (command: string, args: string[]) => {
        if (fixture === 'git-error' || (command !== 'git' && fixture === 'nx-error'))
          throw Error('fixture')
        if (command !== 'git') return fixture === 'nx-invalid' ? '["unknown"]' : 'invalid json'
        if (args.includes('--is-shallow-repository') && fixture === 'shallow') return 'true'
        return execute(command, args)
      }
      expect(await shadowSelection(prContext(), api(), query)).toMatchObject({
        mode: 'full',
        projects: ALL_PROJECTS,
      })
    },
  )
  it('bounds API requests and distinguishes an exhausted window', async () => {
    const github = api(Array.from({ length: 100 }, () => run('a'.repeat(40), { workflow_id: 11 })))
    expect(await shadowSelection(context(), github, execute)).toMatchObject({
      mode: 'full',
      reason: expect.stringContaining('bounded window'),
    })
    expect(github.rest.actions.listWorkflowRuns).toHaveBeenCalledTimes(3)
    expect(github.rest.actions.listWorkflowRuns.mock.calls[0]).toMatchObject([
      { request: { timeout: 10_000 } },
    ])
  })
  it('API failures and missing success fall back, never select empty', async () => {
    const github = api()
    github.rest.actions.getWorkflow.mockRejectedValueOnce(Error('unavailable'))
    expect(await shadowSelection(context(), github, execute)).toMatchObject({
      mode: 'full',
      projects: ALL_PROJECTS,
    })
    expect(await shadowSelection(context(), api([]), execute)).toMatchObject({
      mode: 'full',
      projects: ALL_PROJECTS,
    })
  })
})

describe('actual Nx affected measurements (per-app inputs)', () => {
  const nx = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          join(root, 'node_modules/nx/dist/bin/nx.js'),
          'show',
          'projects',
          '--affected',
          ...args,
          '--json',
        ],
        {
          cwd: root,
          encoding: 'utf8',
          env: { ...process.env, NX_DAEMON: 'false', NX_NO_CLOUD: 'true' },
        },
      ),
    )
  // Control's stack test imports Desktop auth, so Desktop and its dependencies
  // conservatively select Control too. Host still selects only itself and the
  // whole-workspace checks; no library depends on an app.
  const desktop = ['control', 'desktop', 'tooling']
  const host = ['host', 'tooling']
  const runtime = ['control', 'desktop', 'host', 'runtime', 'tooling']
  const extensions = ['control', 'desktop', 'host', 'pi-extensions', 'runtime', 'tooling']
  const libraries = ['control', 'desktop', 'host', 'pi-extensions', 'runtime', 'shared', 'tooling']
  // Site and Desktop never select each other; docs and CI select only the
  // whole-workspace checks. Root install/config keep Nx's select-everything rule.
  it.each([
    ['apps/site/src/pages/index.astro', ['site', 'tooling']],
    ['apps/site/package-lock.json', ['site', 'tooling']],
    ['.infra/phosphor-site/deployment.yaml', ['site', 'tooling']],
    ['.github/workflows/deploy-site.yml', ['site', 'tooling']],
    ['apps/desktop/src/main.tsx', desktop],
    ['apps/desktop/electron/account/gotrue.ts', desktop],
    ['apps/desktop/electron/account/loopback.ts', desktop],
    ['apps/desktop/package-lock.json', desktop],
    ['tools/scripts/fix-node-pty.mjs', desktop],
    ['tools/scripts/install.sh', desktop],
    ['.github/workflows/release-continuous.yml', desktop],
    ['apps/host/src/main.ts', host],
    ['apps/control/src/main.ts', ['control', 'site', 'tooling']],
    ['apps/host/project.json', host],
    ['libs/pi-extensions/pi-ext/headroom.ts', extensions],
    ['libs/session-runtime/src/pi/session-service.ts', runtime],
    ['libs/shared/src/ipc.ts', [...libraries, 'site']],
    ['supabase/config.toml', ['schema', 'tooling']],
    ['tools/scripts/validate.sh', ['tooling']],
    ['.github/workflows/ci.yml', ['tooling']],
    ['docs/README.md', ['tooling']],
    ['README.md', ['tooling']],
    ['nx.json', ALL_PROJECTS],
    ['package.json', ALL_PROJECTS],
    ['package-lock.json', ALL_PROJECTS],
  ])('%s selects %j', (file, expected) => {
    expect(nx(`--files=${file}`).sort()).toEqual([...expected].sort())
  })
  it('equal actual base/head is an unambiguous no-op', () => {
    const checkedOut = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    expect(nx(`--base=${checkedOut}`, `--head=${checkedOut}`)).toEqual([])
  })
})

it('includes every registered project in the fail-closed CI and release inventory', () => {
  const files = globSync('**/project.json', {
    cwd: root,
    exclude: ['**/node_modules/**', '.nx/**', '.phosphor/**', '**/dist/**', '**/out/**'],
  })
  const names = files.map((path) => {
    const config: unknown = JSON.parse(readFileSync(join(root, path), 'utf8'))
    if (
      !config ||
      typeof config !== 'object' ||
      !('name' in config) ||
      typeof config.name !== 'string'
    ) {
      throw new Error('Invalid project registration')
    }
    return config.name
  })
  expect([...ALL_PROJECTS].sort()).toEqual(names.sort())
})

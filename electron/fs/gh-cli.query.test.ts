import { beforeEach, describe, expect, it, vi } from 'vitest'

const { exec } = vi.hoisted(() => ({ exec: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: exec }))
vi.mock('../pi/shell-env', () => ({
  piProcessEnv: async (extra: Record<string, string>) => ({ PATH: '/bin', ...extra }),
}))

const row = {
  number: 17006,
  url: 'https://github.com/example/service/pull/17006',
  title: 'Service update',
  state: 'OPEN',
  headRefName: 'team/service-update',
}
let respond: (args: string[], cwd: string) => string | Error

beforeEach(() => {
  vi.resetModules()
  exec.mockReset()
  respond = () => JSON.stringify([row])
  exec.mockImplementation(
    (
      _file: string,
      args: string[],
      opts: { cwd: string },
      cb: (err: Error | null, output?: { stdout: string; stderr: string }) => void,
    ) => {
      const result = args[0] === '--version' ? 'gh version' : respond(args, opts.cwd)
      if (result instanceof Error) cb(result)
      else cb(null, { stdout: result, stderr: '' })
    },
  )
})

const listCalls = () => exec.mock.calls.filter(([, args]) => args[0] === 'pr')

describe('repository-agnostic PR queries', () => {
  it('keeps the rich query when it succeeds', async () => {
    respond = () => JSON.stringify([{ ...row, statusCheckRollup: [{ state: 'SUCCESS' }] }])
    const { ghPrsForRepo } = await import('./gh-cli')
    const result = await ghPrsForRepo('/work/another-org/service')
    expect(result?.byBranch[row.headRefName]?.checks?.passed).toBe(1)
    expect(result?.complete).toBe(true)
    expect(listCalls()).toHaveLength(1)
    expect(listCalls()[0]?.[2].cwd).toBe('/work/another-org/service')
  })

  it('retries CI-heavy repos with identity and state only, retaining cwd and PR coverage', async () => {
    respond = (args) =>
      args.at(-1)?.includes('statusCheckRollup')
        ? new Error('GraphQL: Resource limits for this query exceeded')
        : JSON.stringify([row])
    const { ghPrsForRepo } = await import('./gh-cli')
    const result = await ghPrsForRepo('/work/another-org/service', 100)
    expect(result?.byBranch[row.headRefName]).toMatchObject({
      number: 17006,
      state: 'OPEN',
      reviewDecision: undefined,
      checks: null,
    })
    expect(listCalls()).toHaveLength(2)
    for (const [, args, opts] of listCalls()) {
      expect(opts.cwd).toBe('/work/another-org/service')
      expect(args).toContain('100')
    }
    expect(listCalls()[1]?.[1].at(-1)).toBe('number,title,state,url,isDraft,headRefName')
  })

  it('uses the same fallback for the branch popup', async () => {
    respond = (args) =>
      args.at(-1)?.includes('statusCheckRollup')
        ? new Error('Resource not accessible by integration')
        : JSON.stringify([row])
    const { ghPrForBranch } = await import('./gh-cli')
    expect(await ghPrForBranch('/work/repo', row.headRefName)).toMatchObject({
      number: 17006,
      checks: null,
    })
    for (const [, args, opts] of listCalls()) {
      expect(opts.cwd).toBe('/work/repo')
      expect(args).toContain(row.headRefName)
    }
  })

  it('returns unavailable, not empty, when both queries fail', async () => {
    respond = () => new Error('authentication required')
    const { ghPrsForRepo } = await import('./gh-cli')
    expect(await ghPrsForRepo('/work/private')).toBeNull()
    expect(listCalls()).toHaveLength(2)
  })

  it.each(['not json', '{}', '[null]', '[{}]'])(
    'does not accept malformed output: %s',
    async (raw) => {
      respond = () => raw
      const { ghPrsForRepo } = await import('./gh-cli')
      expect(await ghPrsForRepo('/work/repo')).toBeNull()
    },
  )

  it('distinguishes a successful empty listing from a full page', async () => {
    const { ghPrsForRepo } = await import('./gh-cli')
    expect((await ghPrsForRepo('/work/repo', 1))?.complete).toBe(false)
    respond = () => '[]'
    expect(await ghPrsForRepo('/work/repo')).toEqual({ byBranch: {}, complete: true })
  })
})

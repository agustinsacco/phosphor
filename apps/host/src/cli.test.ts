import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, type FakeMachine } from './__fixtures__/machine'
import { runCli, USAGE, type CliContext } from './cli'

let machine: FakeMachine | undefined
afterEach(() => {
  vi.unstubAllEnvs()
  machine?.cleanup()
  machine = undefined
})

async function run(argv: string[], context: Partial<CliContext> = {}) {
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    {
      env: {},
      platform: 'linux',
      uid: process.getuid!(),
      home: '/nonexistent/home',
      hostname: 'bee1',
      nodeVersion: '22.22.3',
      defaultResourceRoot: '/nonexistent',
      ...context,
    },
  )
  return { code, ...out }
}

describe('phosphor', () => {
  it('prints its version, plain or as JSON', async () => {
    expect(await run(['version'])).toEqual({
      code: 0,
      stdout: 'phosphor 0.0.0-dev.source\n',
      stderr: '',
    })
    expect(JSON.parse((await run(['version', '--json'])).stdout)).toEqual({
      hostVersion: '0.0.0-dev.source',
      protocolVersion: 1,
      sourceSha: null,
      node: '22.22.3',
    })
  })

  it('prints usage when asked', async () => {
    for (const argv of [['help'], ['--help'], ['-h'], ['doctor', '--help']]) {
      expect(await run(argv)).toEqual({ code: 0, stdout: USAGE, stderr: '' })
    }
  })

  it.each([
    [[], 'no command given'],
    [['serve'], 'unknown command "serve"'],
    [['accept'], 'accept needs --repository DIR'],
    [['accept', '--repository', 'repo'], '--repository needs an absolute path'],
    [['accept', '--repository', '/repo', '--lane', 'both'], '--lane is native, claude or all'],
    [['doctor', '--repository', '/repo'], 'doctor does not take --repository'],
    [['doctor', '--model', 'm'], 'doctor does not take --model'],
    [['version', '--keep-transcripts'], 'version does not take --keep-transcripts'],
    [['doctor', '--nope'], "Unknown option '--nope'"],
    [['doctor', 'extra'], 'unexpected argument "extra"'],
    [['doctor', '--config'], "Option '--config <value>' argument missing"],
    [['doctor', '--config', ''], '--config needs a file'],
    [['version', '--config', '/x.json'], 'version does not take --config'],
  ])('refuses %j with exit 64 and usage on stderr', async (argv, problem) => {
    const result = await run(argv)
    expect(result).toMatchObject({ code: 64, stdout: '' })
    expect(result.stderr).toContain(problem)
    expect(result.stderr.endsWith(USAGE)).toBe(true)
  })

  it('runs doctor against --config, with the report alone on stdout', async () => {
    machine = fakeMachine()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    const result = await run(['doctor', '--json', '--config', machine.configPath], {
      env: machine.hostEnv,
      home: machine.home,
    })
    expect(result).toMatchObject({ code: 0, stderr: '' })
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      config: { path: machine.configPath },
    })
  })

  it('looks for the config in the XDG folder by default', async () => {
    const result = await run(['doctor'], { env: { XDG_CONFIG_HOME: '/nonexistent/xdg' } })
    expect(result.code).toBe(78)
    expect(result.stdout).toContain('/nonexistent/xdg/phosphor-host/config.json')
  })
})

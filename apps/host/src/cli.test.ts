import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
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
    [['doctor', '--claude-model', 'm'], 'doctor does not take --claude-model'],
    [['version', '--keep-transcripts'], 'version does not take --keep-transcripts'],
    [['providers', '--repository', '/repo'], 'providers does not take --repository'],
    [['providers', 'login'], 'unexpected argument "login"'],
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

  it("runs providers, with the report alone on stdout, or doctor's when pi is unusable", async () => {
    machine = fakeMachine()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    const options = { env: machine.hostEnv, home: machine.home }
    const none = await run(['providers', '--json', '--config', machine.configPath], options)
    expect(none).toMatchObject({ code: 69, stderr: '' })
    expect(JSON.parse(none.stdout)).toMatchObject({ ok: false, hostId: 'test-host' })
    machine.signIn('openai-codex')
    const plain = await run(['providers', '--config', machine.configPath], options)
    expect(plain).toMatchObject({ code: 0, stderr: '' })
    expect(plain.stdout).toMatch(/^phosphor providers · test-host\n/)
    const env = { ...machine.hostEnv, PI_FAKE_MODE: 'leak' }
    const unusable = await run(['providers', '--json', '--config', machine.configPath], {
      ...options,
      env,
    })
    expect(unusable.code).toBe(69)
    expect(unusable.stderr).toBe(
      'phosphor: pi is not usable here, so it was not asked about providers\n',
    )
    expect(JSON.parse(unusable.stdout)).toMatchObject({
      ok: false,
      lanes: { native: { reason: 'failed: pi' } },
    })
  })

  it("passes accept's lane, models and transcript choice through, evidence alone on stdout", async () => {
    machine = fakeMachine({ rpc: true })
    machine.installClaude()
    vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
    vi.stubEnv('PATH', process.env.PATH)
    const argv = ['accept', '--json', '--config', machine.configPath, '--repository']
    const result = await run(
      [
        ...argv,
        machine.repository,
        '--lane',
        'claude',
        '--claude-model',
        'claude-test',
        '--keep-transcripts',
      ],
      {
        env: machine.hostEnv,
        home: machine.home,
      },
    )
    expect(result.code, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout).lanes).toEqual([
      expect.objectContaining({ lane: 'claude', model: 'claude-test', transcriptDeleted: false }),
    ])
  })

  // The setup steps end in an accept: the one doctor names must pass as written.
  it.each([
    {
      setup: "pi's default is Claude",
      claude: true,
      settings: { defaultProvider: 'pi-claude-cli' },
      signedIn: ['openai-codex'],
      // The fake pi's stand-in for pi running on its default.
      env: { PI_FAKE_PROVIDER: 'pi-claude-cli' },
      lane: 'claude',
    },
    {
      setup: "pi's default is a signed-in provider, with the claude lane available",
      claude: true,
      settings: { defaultProvider: 'openai-codex' },
      signedIn: ['openai-codex'],
      env: { PI_FAKE_PROVIDER: 'openai-codex' },
      lane: 'native',
    },
    {
      setup: 'pi has no default provider',
      claude: false,
      settings: {},
      signedIn: ['xai'],
      env: {},
      lane: 'native',
      model: 'grok-test',
    },
    {
      setup: "only the claude lane can run, pi's default being signed out",
      claude: true,
      settings: { defaultProvider: 'openai' },
      signedIn: [],
      env: {},
      lane: 'claude',
      model: 'claude-test',
    },
  ])(
    'recommends an accept that passes as written when $setup',
    { timeout: 30_000 },
    async ({ claude, settings, signedIn, env, lane, model }) => {
      machine = fakeMachine({ rpc: true })
      if (claude) machine.installClaude()
      const packages = claude ? { packages: ['npm:@saccolabs/pi-claude-cli'] } : {}
      writeFileSync(
        join(machine.agentDir, 'settings.json'),
        JSON.stringify({ ...packages, ...settings }),
      )
      machine.signIn(...signedIn)
      vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
      vi.stubEnv('PATH', process.env.PATH)
      const options = { env: { ...machine.hostEnv, ...env }, home: machine.home }
      const config = ['--json', '--config', machine.configPath]
      const doctor = await run(['doctor', ...config], options)
      const next: string = JSON.parse(doctor.stdout).next
      const command = next.slice(next.indexOf('phosphor ') + 'phosphor '.length)
      const argv = command
        .replace(/ \(pi --list-models [^)]+\)$/, '')
        .split(' ')
        .map((word) => (word === 'DIR' ? machine!.repository : word === 'ID' ? model! : word))
      expect(argv.includes('ID') || argv.includes('DIR')).toBe(false)
      expect(argv.slice(0, 4)).toEqual(['accept', '--repository', machine.repository, '--lane'])
      expect(argv[4]).toBe(lane)
      expect(next.includes(' ID ')).toBe(model !== undefined)
      const result = await run([...argv, ...config], options)
      expect(result.code, `${next}\n${result.stderr}`).toBe(0)
      expect(JSON.parse(result.stdout).lanes).toEqual([
        expect.objectContaining({ lane, verdict: 'pass' }),
      ])
    },
  )

  it('looks for the config in the XDG folder by default', async () => {
    const result = await run(['doctor'], { env: { XDG_CONFIG_HOME: '/nonexistent/xdg' } })
    expect(result.code).toBe(78)
    expect(result.stdout).toContain('/nonexistent/xdg/phosphor-host/config.json')
  })
})

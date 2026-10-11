import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeMachine, SECRET, type FakeMachine } from '../__fixtures__/machine'
import type { runInTerminal } from '../machine/terminal'
import { PI_LOGIN_ARGS, runProviderLogin, type LoginContext } from './provider-login'

let machine: FakeMachine
beforeEach(() => {
  machine = fakeMachine()
  vi.stubEnv('PI_CODING_AGENT_DIR', machine.agentDir)
})
afterEach(() => {
  vi.unstubAllEnvs()
  machine.cleanup()
})

interface Seen {
  file: string
  args: readonly string[]
  cwd: string
  env: Record<string, string>
  /** The folder existed, empty, while the login ran. */
  emptyFolder: boolean
  attach: unknown
}

/** A login that records what it was given, then does what a person would: `act`. */
function fakeLogin(act: () => void = () => {}) {
  const seen: Seen[] = []
  const run: typeof runInTerminal = async (file, args, options) => {
    const emptyFolder = existsSync(options.cwd) && readdirSync(options.cwd).length === 0
    seen.push({
      file,
      args,
      cwd: options.cwd,
      env: options.env,
      emptyFolder,
      attach: options.attach,
    })
    act()
    return { code: 0 }
  }
  return { run, seen }
}

async function login(provider: string, overrides: Partial<LoginContext> = {}) {
  const progress: string[] = []
  const outcome = await runProviderLogin({
    configPath: machine.configPath,
    env: { ...machine.hostEnv, TERM: 'xterm-256color' },
    platform: 'linux',
    uid: process.getuid!(),
    home: machine.home,
    hostname: 'bee1',
    nodeVersion: '22.22.3',
    defaultResourceRoot: '/nonexistent',
    probeTimeoutMs: 5_000,
    provider,
    progress: (line) => void progress.push(line),
    ...overrides,
  })
  return { outcome, progress }
}

/** A claude whose `auth status` follows a file, which its login creates. */
function installSwitchableClaude(): string {
  machine.installClaude()
  const flag = join(machine.dir, 'claude-logged-in')
  machine.script(
    'claude',
    `case "$1" in --version) echo 2.1.283 ;;
auth) if [ -f '${flag}' ]; then echo '{"loggedIn":true,"email":"person@example.com"}'; else echo '{"loggedIn":false}'; exit 1; fi ;;
esac`,
  )
  return flag
}

describe('phosphor providers login', () => {
  it("runs pi's own login in an empty folder with the terminal's type, then shows providers", async () => {
    const { run, seen } = fakeLogin(() => machine.signIn('xai'))
    const attach = () => () => {}
    const { outcome, progress } = await login('xai', { run, attach })
    expect(outcome.exitCode).toBe(0)
    expect(seen).toHaveLength(1)
    const [call] = seen
    expect(call!.file).toBe(process.execPath)
    expect(call!.args).toEqual([machine.cli, '--no-session', '--no-approve', '--no-extensions'])
    expect(PI_LOGIN_ARGS).toEqual(['--no-session', '--no-approve', '--no-extensions'])
    // A signal to the Host must reach the login.
    expect(call!.attach).toBe(attach)
    expect(call!.emptyFolder).toBe(true)
    expect(existsSync(call!.cwd)).toBe(false)
    // pi's environment, as sessions get it, plus TERM, which they never get.
    expect(call!.env.TERM).toBe('xterm-256color')
    expect(call!.env.NODE_OPTIONS).toBeUndefined()
    expect(call!.env.PI_CODING_AGENT_DIR).toBe(machine.agentDir)
    expect(progress[0]).toBe('Signing in to xAI on test-host. pi opens next:')
    expect(progress).toContain(
      '  1. type /login xai and press Enter (twice if pi first completes the name); ' +
        'if pi asks how, choose to sign in with an account',
    )
    expect(progress.at(-1)).toBe('xAI on test-host: signed in.')
    if (!('after' in outcome) || !('report' in outcome.after)) throw new Error('no report')
    expect(outcome.after.report.providers.find((p) => p.id === 'xai')?.status).toBe('ready')
  })

  it('exits 69 when the login ended without signing in, and says so', async () => {
    const { run } = fakeLogin()
    const { outcome, progress } = await login('xai', { run, env: machine.hostEnv })
    expect(outcome.exitCode).toBe(69)
    expect(progress.at(-1)).toBe('xAI on test-host: not signed in.')
  })

  it('passes no TERM when the Host has none', async () => {
    const { run, seen } = fakeLogin()
    await login('xai', { run, env: machine.hostEnv })
    expect(seen[0]!.env.TERM).toBeUndefined()
  })

  it('says a login already there is replaced by signing in again', async () => {
    machine.signIn('xai')
    const { run } = fakeLogin()
    const { outcome, progress } = await login('xai', { run })
    expect(progress[0]).toBe('xAI is already signed in here; signing in again replaces that login.')
    // Still signed in, but the login may not have finished: say which login that can be.
    expect(progress.at(-1)).toBe(
      'xAI on test-host: signed in. It already was, so if the login did not finish, this is the earlier one.',
    )
    expect(outcome.exitCode).toBe(0)
  })

  it('says the same for claude, already logged in before its login', async () => {
    writeFileSync(installSwitchableClaude(), '')
    const { run } = fakeLogin()
    const { outcome, progress } = await login('claude', { run })
    expect(progress[0]).toBe(
      'Claude Code is already logged in here; logging in again replaces that login.',
    )
    expect(progress.at(-1)).toBe(
      'Claude Code on test-host: logged in. It already was, so if the login did not finish, this is the earlier one.',
    )
    expect(outcome.exitCode).toBe(0)
    expect(JSON.stringify({ outcome, progress })).not.toContain('person@example.com')
  })

  it("signs in pi's default provider too, when it is not in the list", async () => {
    writeFileSync(join(machine.agentDir, 'settings.json'), '{"defaultProvider":"openai"}')
    const { run, seen } = fakeLogin(() => machine.signIn('openai'))
    expect((await login('openai', { run })).outcome.exitCode).toBe(0)
    expect(seen).toHaveLength(1)
  })

  it('refuses a provider it does not know, starting nothing', async () => {
    const { run, seen } = fakeLogin()
    const { outcome } = await login('--credentials', { run })
    expect(outcome).toEqual({
      exitCode: 64,
      problem:
        'unknown provider "--credentials": one of openai-codex, anthropic, github-copilot, ' +
        'kimi-for-coding, xai, openrouter, radius, claude',
    })
    expect(seen).toHaveLength(0)
  })

  it('runs claude auth login for the claude lane, and decides by claude auth status', async () => {
    const flag = installSwitchableClaude()
    const { run, seen } = fakeLogin(() => writeFileSync(flag, ''))
    const { outcome, progress } = await login('claude', { run })
    expect(seen.map((call) => [call.file, ...call.args])).toEqual([
      [join(machine.bin, 'claude'), 'auth', 'login'],
    ])
    expect(seen[0]!.emptyFolder).toBe(true)
    expect(progress[0]).toBe('Signing in to Claude Code on test-host. claude auth login runs next:')
    expect(progress.at(-1)).toBe('Claude Code on test-host: logged in.')
    expect(outcome.exitCode).toBe(0)
    expect(JSON.stringify(outcome)).not.toContain('person@example.com')
  })

  it('exits 69 when claude is still logged out after its login', async () => {
    installSwitchableClaude()
    const { run } = fakeLogin()
    const { outcome, progress } = await login('claude', { run })
    expect(outcome.exitCode).toBe(69)
    expect(progress.at(-1)).toBe('Claude Code on test-host: not logged in.')
  })

  it("refuses the claude lane when claude is not on pi's PATH", async () => {
    const { run, seen } = fakeLogin()
    const { outcome } = await login('claude', { run })
    expect(outcome).toEqual({
      exitCode: 69,
      problem: "claude is not on pi's PATH: add its folder to /environment/path",
    })
    expect(seen).toHaveLength(0)
  })

  it('reports a login that could not start', async () => {
    const run: typeof runInTerminal = async () => ({ code: null, error: 'spawn EACCES' })
    const { outcome } = await login('xai', { run })
    expect(outcome).toEqual({
      exitCode: 69,
      problem: `${process.execPath} could not start: spawn EACCES`,
    })
  })

  it("hands back doctor's report when pi itself is unusable, starting nothing", async () => {
    const { run, seen } = fakeLogin()
    const env = { ...machine.hostEnv, PI_FAKE_MODE: 'leak' }
    const { outcome } = await login('xai', { run, env })
    expect(outcome).toMatchObject({
      exitCode: 69,
      problem: 'pi is not usable here, so nothing can sign in through it',
      doctor: { ok: false },
    })
    expect(JSON.stringify(outcome)).not.toContain(SECRET)
    expect(seen).toHaveLength(0)
  })
})

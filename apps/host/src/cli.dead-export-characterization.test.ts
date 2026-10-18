import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { serviceExitPath } from './machine/launchd'
import { hostLogDirectory } from './machine/log'
import { CLI_PARSE_CONFIG, runCli, supervisedRun, USAGE } from './cli'

// The raw argv scan only decides one thing in production: whether a usage
// error belongs to a launchd-supervised run, which records a permanent stop
// and exits 0. Pinned through the public runCli, with no command replaced:
// every argv here is refused before any command could run.
const NOW = Date.UTC(2026, 6, 1, 12, 0, 0)
let home: string
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'phosphor-cli-scan-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

async function cli(argv: readonly string[]) {
  const out = { stdout: '', stderr: '' }
  const code = await runCli(
    argv,
    { stdout: (text) => (out.stdout += text), stderr: (text) => (out.stderr += text) },
    {
      env: {},
      platform: 'darwin',
      uid: process.getuid?.(),
      home,
      hostname: 'bee1',
      nodeVersion: '22.22.3',
      defaultResourceRoot: '/nonexistent',
      control: { now: () => NOW },
    },
  )
  return { code, ...out }
}

function problemOf(argv: readonly string[], fallback: string): string {
  try {
    parseArgs({ ...CLI_PARSE_CONFIG, args: [...argv] })
  } catch (error) {
    return (error as Error).message
  }
  return fallback
}

const recorded = () => existsSync(serviceExitPath({}, home))

const SUPERVISED: [string[], string][] = [
  [['run', '--supervisor=launchd', '--nope'], ''],
  [['run', '--supervisor', 'launchd', 'extra'], 'unexpected argument "extra"'],
  [['--config', '/c.json', '--supervisor', 'launchd', 'run', '--json'], 'run does not take --json'],
  [['--config=run', 'run', '--supervisor', 'launchd', 'x'], 'unexpected argument "x"'],
  [['run', '--supervisor', 'launchd', '--config', ''], '--config needs a file'],
  [['--supervisor=launchd', 'run', '--supervisor=launchd', '--local'], 'run does not take --local'],
]

const UNSUPERVISED: [string[], string][] = [
  [['--config', 'run', '--supervisor=launchd'], 'no command given'],
  [['--config', 'run', 'doctor', '--supervisor=launchd'], 'doctor does not take --supervisor'],
  [['--', 'run', '--supervisor', 'launchd'], 'unexpected argument "--supervisor"'],
  [['run', '--', '--supervisor=launchd'], 'unexpected argument "--supervisor=launchd"'],
  [['run', '--supervisor=launchd', '--supervisor', 'foo'], '--supervisor is launchd'],
  [['run', '--supervisor=launchd', '--supervisor'], ''],
  [['run', '--supervisor', ''], '--supervisor is launchd'],
  [['run', '--config', '--supervisor=launchd'], ''],
  [['status', '--supervisor=launchd'], 'status does not take --supervisor'],
  [['run', 'extra'], 'unexpected argument "extra"'],
]

describe('runCli supervisor recognition from raw argv', () => {
  it.each(SUPERVISED)('records %j as a permanent launchd stop', async (argv, fallback) => {
    expect(supervisedRun(argv)).toBe(true)
    expect(await cli(argv)).toEqual({
      code: 0,
      stdout: '',
      stderr: `phosphor: ${problemOf(argv, fallback)}\n\n${USAGE}`,
    })
    expect(JSON.parse(readFileSync(serviceExitPath({}, home), 'utf8'))).toEqual({
      code: 64,
      at: new Date(NOW).toISOString(),
    })
    expect(readFileSync(join(hostLogDirectory({}, home), 'phosphor.log'), 'utf8')).toContain(
      '[service] stopped {"code":64}',
    )
  })

  it.each(UNSUPERVISED)('refuses %j with exit 64 and records nothing', async (argv, fallback) => {
    expect(supervisedRun(argv)).toBe(false)
    expect(await cli(argv)).toEqual({
      code: 64,
      stdout: '',
      stderr: `phosphor: ${problemOf(argv, fallback)}\n\n${USAGE}`,
    })
    expect(recorded()).toBe(false)
    expect(existsSync(hostLogDirectory({}, home))).toBe(false)
  })

  it('reads --config run as the config file, not the command', async () => {
    const argv = ['--config', 'run', '--supervisor=launchd']
    expect(parseArgs({ ...CLI_PARSE_CONFIG, args: argv }).positionals).toEqual([])
    expect(await cli(argv)).toMatchObject({ code: 64 })
    expect(recorded()).toBe(false)
  })

  it('prints help for a supervised run asking for it, recording nothing', async () => {
    const argv = ['run', '--supervisor', 'launchd', '--help']
    expect(supervisedRun(argv)).toBe(true)
    expect(await cli(argv)).toEqual({ code: 0, stdout: USAGE, stderr: '' })
    expect(recorded()).toBe(false)
  })
})

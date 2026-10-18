import { parseArgs } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  CLI_PARSE_CONFIG,
  readCliRequest,
  scanArgv,
  supervisedRun,
  type CliRequest,
  type ValidatedCommand,
} from './cli-args'

const command = (argv: readonly string[], terminal?: boolean): ValidatedCommand => {
  const request = readCliRequest(argv, terminal)
  if (request.kind !== 'command') throw new Error(`refused ${JSON.stringify(request)}`)
  return request.command
}
const usage = (problem: string): CliRequest => ({ kind: 'usage', problem })

describe('readCliRequest', () => {
  it('reads help before any refusal, but after a parse error', () => {
    expect(readCliRequest(['serve', '--replace', '-h'], false)).toEqual({ kind: 'help' })
    expect(readCliRequest(['help', 'extra'], false)).toEqual({ kind: 'help' })
    expect(readCliRequest(['--nope', '--help'], false)).toMatchObject({
      kind: 'usage',
      problem: expect.stringContaining("Unknown option '--nope'"),
    })
  })

  it('reads --version and -v alone as the version command', () => {
    for (const flag of ['--version', '-v'])
      expect(command([flag])).toEqual({ name: 'version', options: {} })
    expect(readCliRequest(['--version', 'doctor'], false)).toEqual(usage('no command given'))
  })

  it('types the operands of service, tailscale and providers login', () => {
    expect(command(['service', 'logs', '--follow'])).toEqual({
      name: 'service',
      action: 'logs',
      options: { follow: true },
    })
    expect(command(['tailscale', 'enable', '--config', '/c'])).toEqual({
      name: 'tailscale',
      action: 'enable',
      options: { config: '/c' },
    })
    expect(command(['providers', 'login', 'claude'], true)).toEqual({
      name: 'providers login',
      provider: 'claude',
      options: {},
    })
    expect(command(['providers', '--json'])).toEqual({ name: 'providers', options: { json: true } })
  })

  it('types accept, setup and run from their options', () => {
    expect(command(['accept', '--repository', '/r'])).toMatchObject({
      name: 'accept',
      repository: '/r',
      lane: 'all',
    })
    expect(command(['accept', '--repository', '/r', '--lane', 'claude'])).toMatchObject({
      lane: 'claude',
    })
    expect(command(['setup', '--repository', 'a', '--repository', 'b'])).toMatchObject({
      name: 'setup',
      repositories: ['a', 'b'],
    })
    expect(command(['setup'])).toMatchObject({ repositories: [] })
    expect(command(['run'])).toEqual({ name: 'run', supervisor: undefined, options: {} })
    expect(command(['run', '--supervisor=launchd'])).toMatchObject({ supervisor: 'launchd' })
  })

  it('passes update and uninstall options through once they agree', () => {
    expect(command(['update', '--version', '1.2.3', '--check'])).toEqual({
      name: 'update',
      options: { version: '1.2.3', check: true },
    })
    expect(command(['uninstall', '--purge', '--yes'])).toMatchObject({ name: 'uninstall' })
    expect(readCliRequest(['update', '--rollback', '--check'], false)).toEqual(
      usage('invalid update options'),
    )
    expect(readCliRequest(['uninstall', '--yes'], false)).toEqual(
      usage('--purge and --yes are both required'),
    )
  })

  it('names only its own commands, never an inherited property', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty'])
      expect(readCliRequest([name, '--json'], false)).toEqual(usage(`unknown command "${name}"`))
    expect(readCliRequest(['providers login'], true)).toEqual(
      usage('unknown command "providers login"'),
    )
  })

  it('checks positionals, then options taken, then the terminal, then shared values', () => {
    expect(readCliRequest(['service', 'bogus', '--json'], false)).toEqual(
      usage('service needs install, status, restart, logs or uninstall'),
    )
    expect(readCliRequest(['doctor', 'extra', '--replace'], false)).toEqual(
      usage('unexpected argument "extra"'),
    )
    expect(readCliRequest(['providers', 'login', 'xai', '--json'], false)).toEqual(
      usage('providers login does not take --json'),
    )
    expect(readCliRequest(['providers', 'login', 'xai', '--config', ''], false)).toEqual(
      usage('providers login needs a terminal: over SSH, run ssh -t HOST phosphor ...'),
    )
    expect(readCliRequest(['run', '--supervisor', 'x', '--config', ''], false)).toEqual(
      usage('--supervisor is launchd'),
    )
    expect(readCliRequest(['accept', '--config', '', '--lane', 'x'], false)).toEqual(
      usage('--config needs a file'),
    )
  })

  it('checks accept lane, then repository count, presence and form', () => {
    const accept = (...argv: string[]) => readCliRequest(['accept', ...argv], false)
    expect(accept('--lane', 'x', '--repository', 'a', '--repository', 'b')).toEqual(
      usage('--lane is native, claude or all'),
    )
    expect(accept('--repository', 'a', '--repository', 'b')).toEqual(
      usage('--repository may only repeat for setup'),
    )
    expect(accept('--repository', '')).toEqual(usage('accept needs --repository DIR'))
    expect(accept('--repository', 'a')).toEqual(usage('--repository needs an absolute path'))
  })

  it('refuses an option meant for another command before reading its value', () => {
    expect(readCliRequest(['doctor', '--lane', 'x'], false)).toEqual(
      usage('doctor does not take --lane'),
    )
    expect(readCliRequest(['status', '--supervisor', 'x'], false)).toEqual(
      usage('status does not take --supervisor'),
    )
    expect(readCliRequest(['accept', '--pi', ''], false)).toEqual(
      usage('accept does not take --pi'),
    )
  })
})

describe('raw argv scan', () => {
  const ARGV: string[][] = [
    [],
    ['doctor'],
    ['--config', 'run', 'doctor'],
    ['--config=run', 'doctor'],
    ['--json', 'run'],
    ['-h', 'run'],
    ['--', 'run', '--supervisor', 'launchd'],
    ['run', '--', 'doctor'],
    ['--repository', '/a', '--repository', '/b', 'setup'],
    ['--supervisor', 'launchd', 'run'],
    ['--supervisor=launchd', '--config', '/c', 'run'],
    ['-', 'run'],
    ['--lane', 'claude', 'accept', '--keep-transcripts'],
  ]

  it.each(ARGV)('finds the command parseArgs finds in %j', (...argv) => {
    const parsed = parseArgs({ ...CLI_PARSE_CONFIG, args: argv })
    expect(scanArgv(argv).command).toBe(parsed.positionals[0])
  })

  it('collects every --supervisor value, even a missing one', () => {
    expect(scanArgv(['run', '--supervisor=a', '--supervisor', 'b', '--supervisor'])).toEqual({
      command: 'run',
      supervisors: ['a', 'b', undefined],
    })
  })

  it.each([
    [['run', '--supervisor', 'launchd'], true],
    [['--supervisor=launchd', 'run', '--nope'], true],
    [['run'], false],
    [['run', '--supervisor', 'launchd', '--supervisor', 'other'], false],
    [['--config', 'run', '--supervisor', 'launchd'], false],
    [['run', '--', '--supervisor', 'launchd'], false],
    [['doctor', '--supervisor', 'launchd'], false],
  ])('reads %j as supervised: %s', (argv, supervised) => {
    expect(supervisedRun(argv)).toBe(supervised)
  })
})

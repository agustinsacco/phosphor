import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EXTENSIONS_ROOT, FAKE_PI, SECRET, fakeMachine, type FakeMachine } from './machine'

const machines: FakeMachine[] = []
afterEach(() => {
  for (const machine of machines.splice(0)) machine.cleanup()
})
function machineWith(options?: Parameters<typeof fakeMachine>[0]) {
  const machine = fakeMachine(options)
  machines.push(machine)
  return machine
}
const mode = (path: string) => statSync(path).mode & 0o777
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
function runPi(machine: FakeMachine, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [machine.pi, ...args], {
    encoding: 'utf8',
    env: { PI_CODING_AGENT_DIR: machine.agentDir, ...env },
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('fakeMachine public paths', () => {
  it('exports the bundled extension root, the RPC fake and the secret', () => {
    expect(EXTENSIONS_ROOT).toBe(resolve(import.meta.dirname, '../../../../libs/pi-extensions'))
    expect(FAKE_PI).toBe(resolve(import.meta.dirname, 'fake-pi.cjs'))
    expect(SECRET).toBe('sk-ant-test-0123456789abcdef')
  })

  it('lays out an npm-like pi install, a home, a git repository and an owner-only config', () => {
    const machine = machineWith()
    const { dir } = machine
    expect(dirname(dir)).toBe(realpathSync(tmpdir()))
    expect(dir.slice(dirname(dir).length + 1)).toMatch(/^phosphor-host-/)
    expect(machine).toMatchObject({
      home: join(dir, 'home'),
      agentDir: join(dir, 'home/.pi/agent'),
      repository: join(dir, 'repo'),
      pi: join(dir, 'bin/pi'),
      cli: join(dir, 'pi/dist/bundle/cli.js'),
      bin: join(dir, 'bin'),
      configPath: join(dir, 'config/config.json'),
    })
    expect(statSync(machine.agentDir).isDirectory()).toBe(true)
    expect(existsSync(join(machine.repository, '.git/HEAD'))).toBe(true)
    expect(lstatSync(machine.pi).isSymbolicLink()).toBe(true)
    expect(readlinkSync(machine.pi)).toBe(machine.cli)
    expect(mode(machine.cli)).toBe(0o755)
    expect(readFileSync(machine.cli, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true)
    expect(mode(dirname(machine.configPath))).toBe(0o700)
    expect(mode(machine.configPath)).toBe(0o600)
    expect(machine.config).toEqual({
      version: 1,
      hostId: 'test-host',
      pi: { node: process.execPath, executable: machine.pi },
      resourceRoot: EXTENSIONS_ROOT,
      repositories: [machine.repository],
    })
    expect(json(machine.configPath)).toEqual(machine.config)
  })

  it('gives every machine its own folder and config object', () => {
    const first = machineWith()
    const second = machineWith()
    expect(first.dir).not.toBe(second.dir)
    first.writeConfig({ version: 2 })
    expect(second.config).toMatchObject({ version: 1, hostId: 'test-host' })
    expect(json(second.configPath)).toEqual(second.config)
  })
})

describe('fakeMachine poisoned environment', () => {
  it('starts the Host from a poisoned environment holding one secret', () => {
    const machine = machineWith()
    expect(machine.hostEnv).toEqual({
      HOME: machine.home,
      USER: 'tester',
      LANG: 'en_US.UTF-8',
      PATH: '.:/tmp:/usr/bin:/bin',
      PI_CODING_AGENT_DIR: machine.agentDir,
      ANTHROPIC_API_KEY: SECRET,
      NODE_OPTIONS: '--require=/nonexistent/hook.js',
      LD_PRELOAD: '/nonexistent/hook.so',
      DYLD_INSERT_LIBRARIES: '/nonexistent/hook.dylib',
      BASH_ENV: '/nonexistent/hook.sh',
      SSH_AUTH_SOCK: '/nonexistent/agent.sock',
    })
  })
})

describe('fakeMachine package and engine metadata', () => {
  const manifest = (machine: FakeMachine) => json(join(machine.dir, 'pi/package.json'))

  it('writes pi 1.2.0 with a Node engine range by default', () => {
    const machine = machineWith()
    expect(manifest(machine)).toEqual({
      name: '@earendil-works/pi-coding-agent',
      version: '1.2.0',
      engines: { node: '>=22.19.0' },
    })
    expect(runPi(machine, ['--version'])).toEqual({ status: 0, stdout: '1.2.0\n', stderr: '' })
  })

  it('reports piVersion from the cli and manifestVersion from package.json', () => {
    const machine = machineWith({ piVersion: '0.87.1', manifestVersion: '0.86.0' })
    expect(manifest(machine)).toMatchObject({ version: '0.86.0' })
    expect(runPi(machine, ['--version']).stdout).toBe('0.87.1\n')
    expect(manifest(machineWith({ piVersion: '0.87.1' }))).toMatchObject({ version: '0.87.1' })
  })

  it('writes the engines option as given, even when absent or not a string', () => {
    expect(manifest(machineWith({ engines: undefined }))).toMatchObject({ engines: {} })
    expect(manifest(machineWith({ engines: null }))).toMatchObject({ engines: { node: null } })
    expect(manifest(machineWith({ engines: ['>=1'] }))).toMatchObject({
      engines: { node: ['>=1'] },
    })
  })

  it('copies the RPC fake over the cli with rpc', () => {
    const machine = machineWith({ rpc: true })
    expect(readFileSync(machine.cli, 'utf8')).toBe(readFileSync(FAKE_PI, 'utf8'))
    expect(mode(machine.cli)).toBe(0o755)
    expect(readlinkSync(machine.pi)).toBe(machine.cli)
    expect(manifest(machine)).toMatchObject({ version: '1.2.0' })
  })
})

describe('fakeMachine cli behaviour', () => {
  const check = ['auth', 'check', '--provider', 'anthropic']

  it('answers auth check from the stored credentials', () => {
    const machine = machineWith()
    expect(runPi(machine, check)).toEqual({
      status: 1,
      stdout:
        JSON.stringify({
          status: 'not_ready',
          provider: 'anthropic',
          reason: 'credentials_not_configured',
        }) + '\n',
      stderr: '',
    })
    machine.signIn('anthropic')
    expect(runPi(machine, check)).toEqual({
      status: 0,
      stdout: JSON.stringify({ status: 'ready', provider: 'anthropic', authType: 'oauth' }) + '\n',
      stderr: '',
    })
    expect(JSON.parse(runPi(machine, [...check, '--credentials']).stdout)).toEqual({
      status: 'ready',
      provider: 'anthropic',
      authType: 'oauth',
      credentials: `${SECRET}-anthropic`,
    })
  })

  it('answers invalid or garbage on request', () => {
    const machine = machineWith()
    machine.signIn('anthropic')
    expect(runPi(machine, check, { PI_FAKE_AUTH: 'invalid' })).toEqual({
      status: 2,
      stdout:
        JSON.stringify({ status: 'invalid', provider: 'anthropic', reason: 'invalid_state' }) +
        '\n',
      stderr: '',
    })
    expect(runPi(machine, check, { PI_FAKE_AUTH: 'garbage' })).toEqual({
      status: 0,
      stdout: 'something went wrong\n',
      stderr: '',
    })
  })

  it('leaks the secret after a pad when asked to', () => {
    const machine = machineWith()
    expect(
      runPi(machine, ['--version'], {
        PI_FAKE_MODE: 'leak',
        PI_FAKE_PAD: '3',
        ANTHROPIC_API_KEY: SECRET,
      }),
    ).toEqual({ status: 1, stdout: '', stderr: `cannot start with xxx${SECRET}\n` })
  })

  it('never exits when asked to hang', async () => {
    const machine = machineWith()
    const child = spawn(process.execPath, [machine.pi, '--version'], {
      env: { PI_FAKE_MODE: 'hang' },
      stdio: 'ignore',
    })
    const exited = new Promise((done) => child.once('exit', done))
    await new Promise((done) => setTimeout(done, 300))
    expect(child.exitCode).toBeNull()
    child.kill('SIGKILL')
    await exited
  })
})

describe('fakeMachine signIn, installClaude, script and cleanup', () => {
  it('stores one oauth credential per provider, owner-only', () => {
    const machine = machineWith()
    machine.signIn('anthropic', 'openai')
    const auth = join(machine.agentDir, 'auth.json')
    expect(json(auth)).toEqual({
      anthropic: { type: 'oauth', access: `${SECRET}-anthropic` },
      openai: { type: 'oauth', access: `${SECRET}-openai` },
    })
    expect(mode(auth)).toBe(0o600)
    machine.signIn()
    expect(json(auth)).toEqual({})
  })

  it('writes executable shell scripts into bin', () => {
    const machine = machineWith()
    const file = machine.script('hello', 'echo hi')
    expect(file).toBe(join(machine.bin, 'hello'))
    expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho hi\n')
    expect(mode(file)).toBe(0o755)
    expect(spawnSync(file, { encoding: 'utf8' }).stdout).toBe('hi\n')
  })

  it('installs the Claude provider, a logged-in claude and a PATH config', () => {
    const machine = machineWith()
    const before = machine.config
    machine.installClaude()
    const provider = join(machine.agentDir, 'npm/node_modules/@saccolabs/pi-claude-cli')
    expect(json(join(provider, 'package.json'))).toEqual({
      name: '@saccolabs/pi-claude-cli',
      version: '0.10.0',
    })
    expect(json(join(machine.agentDir, 'settings.json'))).toEqual({
      packages: ['npm:@saccolabs/pi-claude-cli'],
    })
    const claude = join(machine.bin, 'claude')
    expect(mode(claude)).toBe(0o755)
    expect(spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout).toBe('2.1.283\n')
    expect(JSON.parse(spawnSync(claude, ['auth'], { encoding: 'utf8' }).stdout)).toEqual({
      loggedIn: true,
      email: 'person@example.com',
    })
    expect(machine.config).toEqual({ ...before, environment: { path: [machine.bin] } })
    expect(json(machine.configPath)).toEqual(machine.config)
    expect(mode(machine.configPath)).toBe(0o600)
  })

  it('replaces the config in memory and on disk', () => {
    const machine = machineWith()
    machine.writeConfig({ version: 9 })
    expect(machine.config).toEqual({ version: 9 })
    expect(json(machine.configPath)).toEqual({ version: 9 })
    expect(mode(machine.configPath)).toBe(0o600)
  })

  it('removes the whole machine on cleanup, twice without error', () => {
    const machine = fakeMachine()
    machine.cleanup()
    expect(existsSync(machine.dir)).toBe(false)
    machine.cleanup()
  })
})

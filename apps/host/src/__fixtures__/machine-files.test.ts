import { spawnSync } from 'node:child_process'
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAUDE_CLI,
  FAKE_PI,
  createConfigFolder,
  fakeCliSource,
  writeAuth,
  writeClaudeProvider,
  writeConfigFile,
  writePiInstall,
  writeScript,
} from './machine-files'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function scratch() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'host-machine-files-'))
  roots.push(root)
  return root
}
const mode = (path: string) => statSync(path).mode & 0o777
const json = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))
const options = { version: '2.0.0', manifestVersion: '1.9.0', engineRange: '>=1', rpc: false }

describe('writePiInstall', () => {
  it('writes the package, an executable cli and a bin symlink to it', () => {
    const root = scratch()
    const install = writePiInstall(root, options)
    expect(install).toEqual({
      cli: join(root, 'pi/dist/bundle/cli.js'),
      bin: join(root, 'bin'),
      pi: join(root, 'bin/pi'),
    })
    expect(json(join(root, 'pi/package.json'))).toEqual({
      name: '@earendil-works/pi-coding-agent',
      version: '1.9.0',
      engines: { node: '>=1' },
    })
    expect(readFileSync(install.cli, 'utf8')).toBe(fakeCliSource('2.0.0'))
    expect(mode(install.cli)).toBe(0o755)
    expect(lstatSync(install.pi).isSymbolicLink()).toBe(true)
    expect(readlinkSync(install.pi)).toBe(install.cli)
  })

  it('installs the RPC fake as the cli with rpc', () => {
    const root = scratch()
    const install = writePiInstall(root, { ...options, rpc: true })
    expect(readFileSync(install.cli)).toEqual(readFileSync(FAKE_PI))
    expect(mode(install.cli)).toBe(0o755)
  })

  it('refuses a folder that already holds an install', () => {
    const root = scratch()
    writePiInstall(root, options)
    expect(() => writePiInstall(root, options)).toThrow(/EEXIST/)
  })
})

describe('fakeCliSource', () => {
  it('prints the version it was built with, quoted safely', () => {
    const root = scratch()
    const cli = join(root, 'cli.js')
    writeFileSync(cli, fakeCliSource('1.0.0 "quoted"'))
    const result = spawnSync(process.execPath, [cli, '--version'], { encoding: 'utf8', env: {} })
    expect(result.stdout).toBe('1.0.0 "quoted"\n')
    expect(fakeCliSource('1.0.0').startsWith('#!/usr/bin/env node\n')).toBe(true)
  })
})

describe('writeScript', () => {
  it('writes an executable shell script, replacing an earlier file and its mode', () => {
    const bin = scratch()
    writeFileSync(join(bin, 'tool'), 'old', { mode: 0o600 })
    const file = writeScript(bin, 'tool', 'echo "$1"')
    expect(file).toBe(join(bin, 'tool'))
    expect(readFileSync(file, 'utf8')).toBe('#!/bin/sh\necho "$1"\n')
    expect(mode(file)).toBe(0o755)
    expect(spawnSync(file, ['hi'], { encoding: 'utf8' }).stdout).toBe('hi\n')
  })

  it('writes a claude that answers --version and auth', () => {
    const bin = scratch()
    const claude = writeScript(bin, 'claude', CLAUDE_CLI)
    expect(spawnSync(claude, ['--version'], { encoding: 'utf8' }).stdout).toBe('2.1.283\n')
    expect(JSON.parse(spawnSync(claude, ['auth'], { encoding: 'utf8' }).stdout)).toEqual({
      loggedIn: true,
      email: 'person@example.com',
    })
    expect(spawnSync(claude, ['other'], { encoding: 'utf8' }).stdout).toBe('')
  })
})

describe('config files', () => {
  it('creates an owner-only config folder', () => {
    const configPath = join(scratch(), 'config/config.json')
    createConfigFolder(configPath)
    expect(mode(join(configPath, '..'))).toBe(0o700)
  })

  it('replaces the config owner-only, even over a readable file', () => {
    const configPath = join(scratch(), 'config.json')
    writeFileSync(configPath, '{}', { mode: 0o644 })
    writeConfigFile(configPath, { version: 1, list: ['a'] })
    expect(readFileSync(configPath, 'utf8')).toBe('{"version":1,"list":["a"]}')
    expect(mode(configPath)).toBe(0o600)
  })
})

describe('agent folder files', () => {
  it('installs the Claude provider package and pi settings that load it', () => {
    const agentDir = scratch()
    writeClaudeProvider(agentDir)
    expect(json(join(agentDir, 'npm/node_modules/@saccolabs/pi-claude-cli/package.json'))).toEqual({
      name: '@saccolabs/pi-claude-cli',
      version: '0.10.0',
    })
    expect(json(join(agentDir, 'settings.json'))).toEqual({
      packages: ['npm:@saccolabs/pi-claude-cli'],
    })
  })

  it('writes the given credentials to an owner-only auth.json', () => {
    const agentDir = scratch()
    mkdirSync(agentDir, { recursive: true })
    writeAuth(agentDir, { anthropic: { type: 'oauth', access: 'token' } })
    const auth = join(agentDir, 'auth.json')
    expect(json(auth)).toEqual({ anthropic: { type: 'oauth', access: 'token' } })
    expect(mode(auth)).toBe(0o600)
  })
})

import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** The real bundled extensions, so resource checks see what Desktop ships. */
export const EXTENSIONS_ROOT = resolve(import.meta.dirname, '../../../../libs/pi-extensions')

/** The RPC fake: sessions, turns and transcripts, as pi 0.87.1 runs them. */
export const FAKE_PI = resolve(import.meta.dirname, 'fake-pi.cjs')

/** A value no report may ever contain. */
export const SECRET = 'sk-ant-test-0123456789abcdef'

export interface FakeMachine {
  dir: string
  home: string
  agentDir: string
  repository: string
  /** `bin/pi`, a symlink to the fake cli, as npm installs pi globally. */
  pi: string
  /** Real path of the fake cli: `pi/dist/bundle/cli.js`. */
  cli: string
  bin: string
  configPath: string
  config: Record<string, unknown>
  /** Replace the config. Written owner-only, in an owner-only folder. */
  writeConfig(config: Record<string, unknown>): void
  /** An executable `#!/bin/sh` script in bin/. */
  script(name: string, body: string): string
  /** Make the Claude lane available: the provider package in pi, and a logged-in claude on PATH. */
  installClaude(): void
  /** The Host environment tests start from: poisoned, with one secret. */
  hostEnv: Record<string, string>
  cleanup(): void
}

/**
 * A scratch machine: a fake npm install of pi (a Node script with a node
 * shebang and a package.json, like pi 0.87.1), a real git repository, an
 * agent folder and a valid config. The fake pi answers `--version`; with
 * `PI_FAKE_MODE=leak` it fails and prints the secret on stderr instead,
 * after `PI_FAKE_PAD` x's. With `rpc`, pi is the RPC fake instead, which
 * runs sessions.
 */
export function fakeMachine(
  options: { piVersion?: string; manifestVersion?: string; engines?: unknown; rpc?: boolean } = {},
) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-host-'))
  const version = options.piVersion ?? '0.87.1'
  const pkg = join(dir, 'pi')
  const cli = join(pkg, 'dist/bundle/cli.js')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: options.manifestVersion ?? version,
      engines: { node: 'engines' in options ? options.engines : '>=22.19.0' },
    }),
  )
  writeFileSync(
    cli,
    `#!/usr/bin/env node
if (process.env.PI_FAKE_MODE === 'leak') {
  const pad = 'x'.repeat(Number(process.env.PI_FAKE_PAD ?? 0))
  console.error('cannot start with ' + pad + process.env.ANTHROPIC_API_KEY)
  process.exit(1)
}
if (process.env.PI_FAKE_MODE === 'hang') setInterval(() => {}, 1000)
else console.log(${JSON.stringify(version)})
`,
  )
  if (options.rpc) copyFileSync(FAKE_PI, cli)
  chmodSync(cli, 0o755)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const pi = join(bin, 'pi')
  symlinkSync(cli, pi)

  const home = join(dir, 'home')
  const agentDir = join(home, '.pi/agent')
  mkdirSync(agentDir, { recursive: true })
  const repository = join(dir, 'repo')
  execFileSync('git', ['init', '-q', repository])

  const configPath = join(dir, 'config/config.json')
  mkdirSync(dirname(configPath), { mode: 0o700 })
  chmodSync(dirname(configPath), 0o700)

  const machine: FakeMachine = {
    dir,
    home,
    agentDir,
    repository,
    pi,
    cli,
    bin,
    configPath,
    config: {
      version: 1,
      hostId: 'test-host',
      pi: { node: process.execPath, executable: pi },
      resourceRoot: EXTENSIONS_ROOT,
      repositories: [repository],
    },
    writeConfig(config) {
      machine.config = config
      writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
      chmodSync(configPath, 0o600)
    },
    script(name, body) {
      const file = join(bin, name)
      writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
      chmodSync(file, 0o755)
      return file
    },
    installClaude() {
      const provider = join(agentDir, 'npm/node_modules/@saccolabs/pi-claude-cli')
      mkdirSync(provider, { recursive: true })
      writeFileSync(
        join(provider, 'package.json'),
        JSON.stringify({ name: '@saccolabs/pi-claude-cli', version: '0.10.0' }),
      )
      writeFileSync(
        join(agentDir, 'settings.json'),
        JSON.stringify({ packages: ['npm:@saccolabs/pi-claude-cli'] }),
      )
      machine.script(
        'claude',
        `case "$1" in --version) echo 2.1.283 ;; auth) echo '{"loggedIn":true,"email":"person@example.com"}' ;; esac`,
      )
      machine.writeConfig({ ...machine.config, environment: { path: [bin] } })
    },
    hostEnv: {
      HOME: home,
      USER: 'tester',
      LANG: 'en_US.UTF-8',
      PATH: '.:/tmp:/usr/bin:/bin',
      PI_CODING_AGENT_DIR: agentDir,
      ANTHROPIC_API_KEY: SECRET,
      NODE_OPTIONS: '--require=/nonexistent/hook.js',
      LD_PRELOAD: '/nonexistent/hook.so',
      DYLD_INSERT_LIBRARIES: '/nonexistent/hook.dylib',
      BASH_ENV: '/nonexistent/hook.sh',
      SSH_AUTH_SOCK: '/nonexistent/agent.sock',
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
  machine.writeConfig(machine.config)
  return machine
}

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  CLAUDE_CLI,
  FAKE_PI,
  createConfigFolder,
  writeAuth,
  writeClaudeProvider,
  writeConfigFile,
  writePiInstall,
  writeScript,
} from './machine-files'

/** The real bundled extensions, so resource checks see what Desktop ships. */
export const EXTENSIONS_ROOT = resolve(import.meta.dirname, '../../../../libs/pi-extensions')

export { FAKE_PI }

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
  /** Store a credential for each provider in pi's auth.json, as `/login` would. */
  signIn(...providers: string[]): void
  /** The Host environment tests start from: poisoned, with one secret. */
  hostEnv: Record<string, string>
  cleanup(): void
}

/** A Host environment holding `SECRET` and every hook a child must not inherit. */
function poisonedHostEnv(home: string, agentDir: string): Record<string, string> {
  return {
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
  }
}

/**
 * A scratch machine: a fake npm install of pi (a Node script with a node
 * shebang and a package.json, like pi 0.87.1), a real git repository, an
 * agent folder and a valid config. The fake pi answers `--version`, and
 * `auth check` as pi 0.87.1 does, from the providers in the agent folder's
 * auth.json (`signIn`); `PI_FAKE_AUTH=invalid` answers invalid, `=garbage`
 * prints no JSON. With `PI_FAKE_MODE=leak` it fails and prints the secret on
 * stderr instead, after `PI_FAKE_PAD` x's. With `rpc`, pi is the RPC fake
 * instead, which runs sessions.
 */
export function fakeMachine(
  options: { piVersion?: string; manifestVersion?: string; engines?: unknown; rpc?: boolean } = {},
) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-host-'))
  const version = options.piVersion ?? '1.2.0'
  const { cli, bin, pi } = writePiInstall(dir, {
    version,
    manifestVersion: options.manifestVersion ?? version,
    engineRange: 'engines' in options ? options.engines : '>=22.19.0',
    rpc: options.rpc === true,
  })

  const home = join(dir, 'home')
  const agentDir = join(home, '.pi/agent')
  mkdirSync(agentDir, { recursive: true })
  const repository = join(dir, 'repo')
  execFileSync('git', ['init', '-q', repository])

  const configPath = join(dir, 'config/config.json')
  createConfigFolder(configPath)

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
      writeConfigFile(configPath, config)
    },
    script: (name, body) => writeScript(bin, name, body),
    installClaude() {
      writeClaudeProvider(agentDir)
      machine.script('claude', CLAUDE_CLI)
      machine.writeConfig({ ...machine.config, environment: { path: [bin] } })
    },
    signIn(...providers) {
      const stored = Object.fromEntries(
        providers.map((id) => [id, { type: 'oauth', access: `${SECRET}-${id}` }]),
      )
      writeAuth(agentDir, stored)
    },
    hostEnv: poisonedHostEnv(home, agentDir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
  machine.writeConfig(machine.config)
  return machine
}

import { chmodSync, copyFileSync, cpSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** The RPC fake: sessions, turns and transcripts, as pi 0.87.1 runs them. */
export const FAKE_PI = resolve(import.meta.dirname, 'fake-pi.cjs')

/** A logged-in claude on PATH: `--version` and `auth` answer as Claude Code 2.1.283 does. */
export const CLAUDE_CLI = `case "$1" in --version) echo 2.1.283 ;; auth) echo '{"loggedIn":true,"email":"person@example.com"}' ;; esac`

export interface PiInstallOptions {
  /** What the cli prints for `--version`. */
  version: string
  /** The package.json `version`. */
  manifestVersion: string
  /** The package.json `engines.node`, written as given. */
  engineRange: unknown
  /** Install the RPC fake as the cli. */
  rpc: boolean
}

/**
 * The fake pi cli. It answers `--version`, and `auth check` as pi 0.87.1 does,
 * from the providers in the agent folder's auth.json; `PI_FAKE_AUTH=invalid`
 * answers invalid, `=garbage` prints no JSON. With `PI_FAKE_MODE=leak` it fails
 * and prints `ANTHROPIC_API_KEY` on stderr after `PI_FAKE_PAD` x's; with
 * `=hang` it never exits.
 */
export function fakeCliSource(version: string): string {
  return `#!/usr/bin/env node
if (process.env.PI_FAKE_MODE === 'leak') {
  const pad = 'x'.repeat(Number(process.env.PI_FAKE_PAD ?? 0))
  console.error('cannot start with ' + pad + process.env.ANTHROPIC_API_KEY)
  process.exit(1)
}
if (process.env.PI_FAKE_MODE === 'hang') setInterval(() => {}, 1000)
else if (process.argv[2] === 'auth' && process.argv[3] === 'check') {
  const args = process.argv.slice(4)
  const provider = args[args.indexOf('--provider') + 1]
  let stored = {}
  try {
    const file = require('node:path').join(process.env.PI_CODING_AGENT_DIR, 'auth.json')
    stored = JSON.parse(require('node:fs').readFileSync(file, 'utf8'))
  } catch {}
  const mode = process.env.PI_FAKE_AUTH
  const result =
    mode === 'invalid' ? { status: 'invalid', provider, reason: 'invalid_state' }
    : stored[provider] ? { status: 'ready', provider, authType: stored[provider].type }
    : { status: 'not_ready', provider, reason: 'credentials_not_configured' }
  if (args.includes('--credentials') && stored[provider]) result.credentials = stored[provider].access
  console.log(mode === 'garbage' ? 'something went wrong' : JSON.stringify(result))
  process.exitCode = { ready: 0, not_ready: 1 }[result.status] ?? 2
} else console.log(${JSON.stringify(version)})
`
}

/**
 * A global npm install of pi under `dir`: `pi/package.json`, the cli at
 * `pi/dist/bundle/cli.js` (mode 755) and `bin/pi`, a symlink to it.
 */
export function writePiInstall(dir: string, options: PiInstallOptions) {
  const pkg = join(dir, 'pi')
  const cli = join(pkg, 'dist/bundle/cli.js')
  mkdirSync(dirname(cli), { recursive: true })
  writeFileSync(
    join(pkg, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: options.manifestVersion,
      engines: { node: options.engineRange },
    }),
  )
  writeFileSync(cli, fakeCliSource(options.version))
  if (options.rpc) {
    copyFileSync(FAKE_PI, cli)
    cpSync(join(dirname(FAKE_PI), 'fake-pi'), join(dirname(cli), 'fake-pi'), {
      recursive: true,
      filter: (source) => !source.endsWith('.test.ts'),
    })
  }
  chmodSync(cli, 0o755)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  const pi = join(bin, 'pi')
  symlinkSync(cli, pi)
  return { cli, bin, pi }
}

/** An executable `#!/bin/sh` script in `bin`, mode 755 whatever the umask. */
export function writeScript(bin: string, name: string, body: string): string {
  const file = join(bin, name)
  writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  chmodSync(file, 0o755)
  return file
}

/** The config's folder, owner-only (700). */
export function createConfigFolder(configPath: string): void {
  mkdirSync(dirname(configPath), { mode: 0o700 })
  chmodSync(dirname(configPath), 0o700)
}

/** Replace the config file, owner-only (600). */
export function writeConfigFile(configPath: string, config: Record<string, unknown>): void {
  writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 })
  chmodSync(configPath, 0o600)
}

/** The Claude provider package installed in pi, and pi's settings loading it. */
export function writeClaudeProvider(agentDir: string): void {
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
}

/** pi's auth.json, owner-only, as `/login` leaves it. */
export function writeAuth(
  agentDir: string,
  credentials: Record<string, { type: string; access: string }>,
): void {
  writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(credentials), { mode: 0o600 })
}

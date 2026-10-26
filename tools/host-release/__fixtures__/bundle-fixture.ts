import { execFileSync, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { expect } from 'vitest'
import { writeNodeShim } from './node-shim'

export const root = resolve(import.meta.dirname, '../../..')
export const target = `${process.platform}-${process.arch}`
export const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
/** Runs an ES module snippet from the repository root as release version 1.2.3. */
export const node = (source: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST_RELEASE_VERSION: '1.2.3', ...env },
  })

export interface NodePin {
  version: string
  archives: Record<string, string>
}
/** One suite's signed-release inputs, all inside its own temp root. Fixtures share nothing. */
export interface BundleFixture {
  readonly dir: string
  /** install.sh generated with this fixture's `key.pub` as the only pinned signer. */
  readonly script: string
  /** Holds a Node archive built from this test runtime, matched by `pin`. */
  readonly cache: string
  readonly pin: NodePin
  /** Folder of the bundle build that produced `bundle`. */
  readonly out: string
  readonly publicKey: string
  readonly privateKey: string
  /** Artifact the next prepared release publishes. A case may swap it but must restore it. */
  bundle: Buffer
  /** Holds the symlink the archive's Node shim execs; outside `dir` on purpose. */
  readonly nodeDir: string
}
export interface ReleaseMetadata {
  schema: number
  version: string
  protocols: number[]
  node: string
  sourceCommit: string
  artifacts: { target: string; file: string; bytes: number; sha256: string }[]
}
export type PrepareInstall = (home: string, release: string) => NodeJS.ProcessEnv
export interface InstallOptions {
  /** Edits the manifest before it is serialized and signed. */
  change?: (manifest: ReleaseMetadata) => void
  /** Rewrites the serialized manifest text before it is signed. */
  rawManifest?: (json: string) => string
  namespace?: string
  /** Signing key file in the fixture root: `key` is pinned by the installer, `other` is not. */
  key?: 'key' | 'other'
  algorithm?: string
  /** Changes the signed manifest's version afterwards, so its signature no longer matches. */
  flip?: boolean
  /** Version argument for install.sh; an empty string installs through the latest alias. */
  requested?: string
  /** Runs after the release and home exist; its env is added to the installer's. */
  prepare?: PrepareInstall
  flags?: string[]
}
export interface PreparedHome {
  home: string
  /** TMPDIR given to the installer, which must leave it empty. */
  temp: string
  /** Existing install root: `current` selects `versions/old`, which holds a marker. */
  old: string
}

/** Creates a fixture. If any step fails its temp root is removed before the error is rethrown. */
export function setupBundleFixture(): BundleFixture {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-bundles-test-')))
  let nodeDir: string | undefined
  try {
    for (const name of ['key', 'other'])
      execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
    const publicKey = readFileSync(join(dir, 'key.pub'), 'utf8').trim()
    const privateKey = readFileSync(join(dir, 'key'), 'utf8')
    const script = join(dir, 'install.sh')
    node(
      `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(script)}, ${JSON.stringify([{ id: 'test', publicKey }])})`,
    )
    const cache = join(dir, 'cache')
    const stage = join(dir, 'node-stage')
    nodeDir = writeNodeShim(join(stage, nodePrefix, 'bin/node'))
    const pin = archiveNodeStage(stage, cache)
    const out = join(dir, 'out')
    const bundle = buildFixtureBundle({ cache, pin }, out)
    return { dir, script, cache, pin, out, publicKey, privateKey, bundle, nodeDir }
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    if (nodeDir) rmSync(nodeDir, { recursive: true, force: true })
    throw error
  }
}
/** Accepts a fixture whose setup failed, so a suite's afterAll needs no guard. */
export function disposeBundleFixture(fixture: BundleFixture | undefined) {
  if (!fixture) return
  rmSync(fixture.dir, { recursive: true, force: true })
  rmSync(fixture.nodeDir, { recursive: true, force: true })
}
const nodePrefix = `node-v24.14.1-${target}`
function archiveNodeStage(stage: string, cache: string): NodePin {
  writeFileSync(join(stage, nodePrefix, 'LICENSE'), 'Test runtime license\n')
  mkdirSync(cache)
  const cached = join(cache, `${nodePrefix}.tar.gz`)
  node(
    `import {archive} from './tools/host-release/archive.mjs'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(cached)},archive(${JSON.stringify(stage)}))`,
  )
  return { version: '24.14.1', archives: { [target]: hash(readFileSync(cached)) } }
}
/** Builds this target's bundle into `folder` with the fixture's Node pin and returns its bytes. */
export function buildFixtureBundle(
  fixture: Pick<BundleFixture, 'cache' | 'pin'>,
  folder: string,
  env: NodeJS.ProcessEnv = {},
) {
  node(
    `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(folder)},${JSON.stringify(fixture.cache)},${JSON.stringify(fixture.pin)})`,
    env,
  )
  return readFileSync(join(folder, `phosphor-host-1.2.3-${target}.tar.gz`))
}
export function metadata(fixture: Pick<BundleFixture, 'bundle'>): ReleaseMetadata {
  return {
    schema: 1,
    version: '1.2.3',
    protocols: [1],
    node: '24.14.1',
    sourceCommit: 'a'.repeat(40),
    artifacts: [
      {
        target,
        file: `phosphor-host-1.2.3-${target}.tar.gz`,
        bytes: fixture.bundle.length,
        sha256: hash(fixture.bundle),
      },
    ],
  }
}
/** Writes a signed manifest and the fixture's bundle into a new release folder. */
export function prepareRelease(fixture: BundleFixture, options: InstallOptions = {}) {
  const {
    change = () => {},
    rawManifest = (json: string) => json,
    namespace = 'phosphor-host-release',
    key = 'key',
    algorithm = 'sha512',
    flip = false,
    requested = '1.2.3',
  } = options
  const release = mkdtempSync(join(fixture.dir, 'release-'))
  const m = metadata(fixture)
  change(m)
  const file = join(
    release,
    requested ? 'phosphor-host-1.2.3.manifest.json' : 'phosphor-host.manifest.json',
  )
  const bytes = Buffer.from(rawManifest(JSON.stringify(m, null, 2) + '\n'))
  writeFileSync(file, bytes)
  execFileSync(
    'ssh-keygen',
    [
      '-Y',
      'sign',
      '-f',
      join(fixture.dir, key),
      '-n',
      namespace,
      '-O',
      `hashalg=${algorithm}`,
      file,
    ],
    { stdio: 'pipe' },
  )
  if (flip) writeFileSync(file, Buffer.from(bytes.toString().replace('1.2.3', '1.2.4')))
  writeFileSync(join(release, `phosphor-host-1.2.3-${target}.tar.gz`), fixture.bundle)
  return release
}
/** Creates a home holding an existing install and a launcher that points through `current`. */
export function prepareHome(fixture: Pick<BundleFixture, 'dir'>): PreparedHome {
  const home = mkdtempSync(join(fixture.dir, 'home-'))
  const temp = join(home, 'temp')
  mkdirSync(temp)
  const old = join(home, '.local/lib/phosphor-host')
  mkdirSync(join(old, 'versions/old'), { recursive: true })
  writeFileSync(join(old, 'versions/old/marker'), 'unchanged')
  execFileSync('ln', ['-s', 'versions/old', join(old, 'current')])
  mkdirSync(join(home, '.local/bin'))
  execFileSync('ln', ['-s', join(old, 'current/bin/phosphor'), join(home, '.local/bin/phosphor')])
  return { home, temp, old }
}
/**
 * Runs the fixture's installer against a newly prepared release and home. Whatever the outcome,
 * it asserts that the key stayed out of the output, TMPDIR is empty, the old version's marker is
 * intact, and the install lock exists only when `prepare` returned KEEP_LOCK=1.
 */
export function install(fixture: BundleFixture, options: InstallOptions = {}) {
  const { requested = '1.2.3', prepare, flags = [] } = options
  const release = prepareRelease(fixture, options)
  const { home, temp, old } = prepareHome(fixture)
  const extraEnv = prepare?.(home, release) ?? {}
  const result = spawnSync('sh', [fixture.script, ...(requested ? [requested] : []), ...flags], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
      ...extraEnv,
    },
  })
  expect(result.stdout + result.stderr).not.toContain(fixture.privateKey.trim())
  expect(readdirSync(temp)).toEqual([])
  expect(readFileSync(join(old, 'versions/old/marker'), 'utf8')).toBe('unchanged')
  expect(existsSync(join(old, '.install-lock'))).toBe(extraEnv.KEEP_LOCK === '1')
  return { result, home, old }
}
export function installPrepared(
  fixture: BundleFixture,
  prepare: PrepareInstall,
  flags: string[] = [],
) {
  return install(fixture, { prepare, flags })
}
export function launcher(home: string) {
  return join(home, '.local/bin/phosphor')
}
/**
 * Shims `command` for one home: the shim runs `body` with `$real` set, then execs the real
 * command. Returns a PATH that puts this home's shims first; other homes are unaffected.
 */
export function hook(home: string, command: string, body: string) {
  const commands = join(home, 'commands')
  mkdirSync(commands, { recursive: true })
  const real = execFileSync('sh', ['-c', `command -v ${command}`], { encoding: 'utf8' }).trim()
  writeFileSync(
    join(commands, command),
    `#!/bin/sh\nreal='${real}'\n${body}\nexec "$real" "$@"\n`,
    {
      mode: 0o755,
    },
  )
  return `${commands}:${process.env.PATH}`
}
/** Runs the fixture's installer again for an existing home and release, without hooks. */
export function rerun(fixture: Pick<BundleFixture, 'script'>, home: string, release: string) {
  return spawnSync('sh', [fixture.script, '1.2.3'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: join(home, 'temp'),
      PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
    },
  })
}

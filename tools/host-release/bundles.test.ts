import { execFileSync, spawnSync, spawn } from 'node:child_process'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HOST_RELEASE_BASE_URL } from '../../apps/host/src/update/download'
import { verifyReleaseManifest } from '../../apps/host/src/update/verify'
import { createIdentityStore, identityDirectory } from '../../apps/host/src/control/identity'
import { controlMachine } from '../../apps/host/src/control/__fixtures__/machine'
import { freshKey } from '../../apps/host/src/control/signer'
import { fakeMachine } from '../../apps/host/src/__fixtures__/machine'
import { HOST_PROTOCOL_VERSION } from '../../libs/shared/src/remote-host'
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-bundles-test-')))
const root = resolve(import.meta.dirname, '../..')
const target = `${process.platform}-${process.arch}`
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const node = (source: string, env: NodeJS.ProcessEnv = {}) =>
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOST_RELEASE_VERSION: '1.2.3', ...env },
  })
const script = join(dir, 'install.sh')
const cache = join(dir, 'cache')
const out = join(dir, 'out')
let bundle: Buffer
let publicKey: string
let privateKey: string
beforeAll(() => {
  for (const name of ['key', 'other'])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
  publicKey = readFileSync(join(dir, 'key.pub'), 'utf8').trim()
  privateKey = readFileSync(join(dir, 'key'), 'utf8')
  node(
    `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(script)}, ${JSON.stringify([{ id: 'test', publicKey }])})`,
  )
  const stage = join(dir, 'node-stage')
  const prefix = `node-v24.14.1-${target}`
  mkdirSync(join(stage, prefix, 'bin'), { recursive: true })
  cpSync(process.execPath, join(stage, prefix, 'bin/node'))
  writeFileSync(join(stage, prefix, 'LICENSE'), 'Test runtime license\n')
  mkdirSync(cache)
  const cached = join(cache, `${prefix}.tar.gz`)
  node(
    `import {archive} from './tools/host-release/archive.mjs'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(cached)},archive(${JSON.stringify(stage)}))`,
  )
  const pin = { version: '24.14.1', archives: { [target]: hash(readFileSync(cached)) } }
  const build = (folder: string) =>
    node(
      `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(folder)},${JSON.stringify(cache)},${JSON.stringify(pin)})`,
    )
  build(out)
  build(join(dir, 'second'))
  const file = `phosphor-host-1.2.3-${target}.tar.gz`
  bundle = readFileSync(join(out, file))
  expect(readFileSync(join(dir, 'second', file)).equals(bundle)).toBe(true)
}, 60000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function metadata() {
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
        bytes: bundle.length,
        sha256: hash(bundle),
      },
    ],
  }
}
function install(
  change: (manifest: ReturnType<typeof metadata>) => void = () => {},
  namespace = 'phosphor-host-release',
  key = 'key',
  flip = false,
  requested = '1.2.3',
  prepare?: (home: string, release: string) => NodeJS.ProcessEnv,
  algorithm = 'sha512',
  flags: string[] = [],
  rawManifest: (json: string) => string = (json) => json,
) {
  const release = mkdtempSync(join(dir, 'release-'))
  const home = mkdtempSync(join(dir, 'home-'))
  const temp = join(home, 'temp')
  mkdirSync(temp)
  const m = metadata()
  change(m)
  const file = join(
    release,
    requested ? 'phosphor-host-1.2.3.manifest.json' : 'phosphor-host.manifest.json',
  )
  const bytes = Buffer.from(rawManifest(JSON.stringify(m, null, 2) + '\n'))
  writeFileSync(file, bytes)
  execFileSync(
    'ssh-keygen',
    ['-Y', 'sign', '-f', join(dir, key), '-n', namespace, '-O', `hashalg=${algorithm}`, file],
    { stdio: 'pipe' },
  )
  if (flip) writeFileSync(file, Buffer.from(bytes.toString().replace('1.2.3', '1.2.4')))
  writeFileSync(join(release, `phosphor-host-1.2.3-${target}.tar.gz`), bundle)
  const old = join(home, '.local/lib/phosphor-host')
  mkdirSync(join(old, 'versions/old'), { recursive: true })
  writeFileSync(join(old, 'versions/old/marker'), 'unchanged')
  execFileSync('ln', ['-s', 'versions/old', join(old, 'current')])
  mkdirSync(join(home, '.local/bin'))
  execFileSync('ln', ['-s', join(old, 'current/bin/phosphor'), join(home, '.local/bin/phosphor')])
  const extraEnv = prepare?.(home, release) ?? {}
  const result = spawnSync('sh', [script, ...(requested ? [requested] : []), ...flags], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: temp,
      PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
      ...extraEnv,
    },
  })
  expect(result.stdout + result.stderr).not.toContain(privateKey.trim())
  expect(readdirSync(temp)).toEqual([])
  expect(readFileSync(join(old, 'versions/old/marker'), 'utf8')).toBe('unchanged')
  expect(existsSync(join(old, '.install-lock'))).toBe(extraEnv.KEEP_LOCK === '1')
  return { result, home, old }
}
function installPrepared(
  prepare: (home: string, release: string) => NodeJS.ProcessEnv,
  flags: string[] = [],
) {
  return install(undefined, undefined, undefined, undefined, undefined, prepare, undefined, flags)
}
function launcher(home: string) {
  return join(home, '.local/bin/phosphor')
}
function hook(home: string, command: string, body: string) {
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
function rerun(home: string, release: string) {
  return spawnSync('sh', [script, '1.2.3'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: join(home, 'temp'),
      PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
    },
  })
}
const withoutPublicReleaseUrl = (text: string) => text.replaceAll(HOST_RELEASE_BASE_URL, '')

describe('signed Host bundle tools', { timeout: 60_000 }, () => {
  it('builds byte-identical bundles and installs without system Node, including latest alias', () => {
    for (const requested of ['1.2.3', '']) {
      const { result, home } = install(undefined, undefined, undefined, undefined, requested)
      expect(result.status, result.stderr).toBe(0)
      const version = execFileSync(join(home, '.local/bin/phosphor'), ['version'], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      })
      expect(version).toContain('1.2.3')
    }
  })
  it.each([false, true])('names a usable setup command when local bin is on PATH: %s', (onPath) => {
    const { result } = installPrepared((home) => ({
      PATH: onPath ? `${home}/.local/bin:${process.env.PATH}` : '/usr/bin:/bin',
    }))
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(
      onPath ? 'Next: phosphor setup' : 'Next: ~/.local/bin/phosphor setup',
    )
    expect(result.stdout.includes('export PATH="$HOME/.local/bin:$PATH"')).toBe(!onPath)
  })
  it.each(['zsh', 'bash'])(
    'adds one guarded PATH block for %s, preserves user content and survives reruns',
    (shell) => {
      const { result, home, release } = (() => {
        let source = ''
        const installed = installPrepared((home, release) => {
          source = release
          writeFileSync(join(home, `.${shell}rc`), '# user content\n')
          return { SHELL: `/bin/${shell}`, PATH: '/usr/bin:/bin' }
        })
        return { ...installed, release: source }
      })()
      expect(result.status, result.stderr).toBe(0)
      const file = join(home, `.${shell}rc`)
      expect(result.stdout).toContain(`Added Phosphor Host PATH to ${file}`)
      expect(readFileSync(file, 'utf8')).toContain('# user content\n')
      const again = spawnSync('sh', [script, '1.2.3'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          SHELL: `/bin/${shell}`,
          PATH: '/usr/bin:/bin',
          PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
        },
      })
      expect(again.status, again.stderr).toBe(0)
      expect(readFileSync(file, 'utf8').split('# >>> Phosphor Host PATH >>>')).toHaveLength(2)
      if (shell === 'bash' && process.platform === 'darwin')
        expect(
          readFileSync(join(home, '.profile'), 'utf8').split('# >>> Phosphor Host PATH >>>'),
        ).toHaveLength(2)
      const resolved = spawnSync('sh', ['-c', `. "$HOME/.${shell}rc"; command -v phosphor`], {
        encoding: 'utf8',
        env: { HOME: home, PATH: '/usr/bin:/bin' },
      })
      expect(resolved.stdout.trim()).toBe(join(home, '.local/bin/phosphor'))
      const twice = spawnSync(
        'sh',
        ['-c', `. "$HOME/.${shell}rc"; . "$HOME/.${shell}rc"; printf '%s' "$PATH"`],
        { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } },
      )
      expect(
        twice.stdout.split(':').filter((entry) => entry === join(home, '.local/bin')),
      ).toHaveLength(1)
    },
  )
  it.each(['opt-out', 'symlink', 'directory', 'foreign-owner', 'on-path', 'other-shell'])(
    'leaves rc unchanged for %s and prints the same-shell export when needed',
    (scenario) => {
      const { result, home } = installPrepared((home) => {
        const rc = join(home, '.zshrc')
        if (scenario === 'symlink') {
          writeFileSync(join(home, 'target'), 'keep')
          execFileSync('ln', ['-s', 'target', rc])
        } else if (scenario === 'directory') mkdirSync(rc)
        else writeFileSync(rc, 'keep')
        return {
          SHELL: scenario === 'other-shell' ? '/bin/fish' : '/bin/zsh',
          PATH:
            scenario === 'on-path'
              ? `${home}/.local/bin:/usr/bin:/bin`
              : scenario === 'foreign-owner'
                ? hook(
                    home,
                    'ls',
                    'if [ "$2" = "$HOME/.zshrc" ]; then echo "-rw------- 1 999999 0 4 Jan 1 file"; exit 0; fi',
                  )
                : '/usr/bin:/bin',
          ...(scenario === 'opt-out' ? { PHOSPHOR_NO_MODIFY_PATH: '1' } : {}),
        }
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).not.toContain('Added Phosphor Host PATH')
      if (['symlink', 'directory', 'foreign-owner'].includes(scenario))
        expect(result.stdout).toContain('Left unsafe shell startup file unchanged:')
      if (scenario !== 'directory') expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('keep')
      expect(result.stdout.includes('export PATH="$HOME/.local/bin:$PATH"')).toBe(
        scenario !== 'on-path',
      )
    },
  )
  it('runs doctor and initializes routines from the built Host without SQLite warnings or folders', async () => {
    const machine = fakeMachine()
    const server = createServer((_request, response) => {
      response.writeHead(410, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { code: 'gone', message: 'removed' } }))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('fixture address')
    const origin = `http://127.0.0.1:${address.port}`
    try {
      machine.writeConfig({
        ...machine.config,
        repositories: [],
        control: { url: origin },
      })
      await createIdentityStore(identityDirectory(machine.configPath), process.getuid?.()).save(
        {
          version: 1,
          hostId: '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00',
          label: 'test',
          ownerLogin: null,
          controlUrl: origin,
          savedAt: new Date().toISOString(),
        },
        freshKey(),
      )
      const { home, result } = install()
      expect(result.status, result.stderr).toBe(0)
      for (const command of ['doctor', 'run']) {
        const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const process = spawn(
              join(home, '.local/bin/phosphor'),
              [command, '--config', machine.configPath],
              {
                signal: AbortSignal.timeout(15000),
                env: {
                  ...machine.hostEnv,
                  NODE_OPTIONS: '',
                  DYLD_INSERT_LIBRARIES: '',
                  LD_PRELOAD: '',
                  PI_CODING_AGENT_DIR: machine.agentDir,
                  XDG_STATE_HOME: join(machine.dir, 'state'),
                },
              },
            )
            let stdout = '',
              stderr = ''
            process.stdout.on('data', (chunk) => {
              stdout += chunk
            })
            process.stderr.on('data', (chunk) => {
              stderr += chunk
            })
            process.on('error', reject)
            process.on('close', (status) => resolve({ status, stdout, stderr }))
          },
        )
        expect(child.stderr).not.toContain('ExperimentalWarning')
        expect(child.status, child.stdout + child.stderr).toBe(command === 'doctor' ? 0 : 77)
      }
      expect(existsSync(join(machine.dir, 'state/phosphor-host/routines/state.sqlite'))).toBe(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      machine.cleanup()
    }
  })
  it('runs the terminal install command and guided setup against local control, then resumes safely', async () => {
    const control = await controlMachine()
    const machine = fakeMachine()
    control.setCreation({ expiresAt: new Date(Date.now() + 600000).toISOString() })
    const fetch = control.context.fetch
    if (!fetch) throw new Error('fixture fetch')
    const server = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const headers = new Headers()
        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
        }
        const answer = await fetch(`http://localhost${request.url}`, {
          method: request.method,
          headers,
          body: Buffer.concat(chunks).toString() || undefined,
        })
        response.writeHead(answer.status, { 'Content-Type': 'application/json' })
        response.end(await answer.text())
      })().catch(() => {
        response.writeHead(500)
        response.end()
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('fixture address')
      let release = ''
      const prepared = installPrepared((_home, source) => {
        release = source
        return {}
      })
      expect(prepared.result.status, prepared.result.stderr).toBe(0)
      const home = mkdtempSync(join(dir, 'terminal-home-'))
      const config = join(home, '.config/phosphor-host')
      mkdirSync(config, { recursive: true, mode: 0o700 })
      writeFileSync(
        join(config, 'config.json'),
        JSON.stringify({
          ...machine.config,
          repositories: [],
          environment: { path: [machine.bin] },
          control: { url: `http://127.0.0.1:${address.port}` },
        }),
        { mode: 0o600 },
      )
      machine.script(
        'launchctl',
        'case "$1" in print) [ -f "$HOME/service-ready" ] || exit 113 ;; bootstrap) touch "$HOME/service-ready" ;; esac',
      )
      machine.script(
        'systemctl',
        'case "$2" in is-active) [ -f "$HOME/service-ready" ] || exit 3 ;; restart) touch "$HOME/service-ready" ;; esac',
      )
      machine.script('loginctl', 'exit 0')
      machine.script(
        'tailscale',
        `case "$1 $2" in
        "status --json") echo '{"BackendState":"Running","CertDomains":["bee.tail.ts.net"],"Self":{"DNSName":"bee.tail.ts.net."}}' ;;
        "serve status") if [ -f "$HOME/route-ready" ]; then echo '{"TCP":{"47615":{"HTTPS":true}},"Web":{"bee.tail.ts.net:47615":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47615"}}}}}'; else echo '{}'; fi ;;
        "serve --bg") touch "$HOME/route-ready" ;;
        *) exit 1 ;;
      esac`,
      )
      // The helper prepares versioned manifests; publish its same signed bytes under the latest alias.
      cpSync(
        join(release, 'phosphor-host-1.2.3.manifest.json'),
        join(release, 'phosphor-host.manifest.json'),
      )
      cpSync(
        join(release, 'phosphor-host-1.2.3.manifest.json.sig'),
        join(release, 'phosphor-host.manifest.json.sig'),
      )
      const child = await new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const command = spawn(
            'sh',
            [
              '-c',
              'sh "$INSTALLER" && export PATH="$HOME/.local/bin:$PATH" && command -v phosphor && phosphor setup && phosphor setup',
            ],
            {
              signal: AbortSignal.timeout(20000),
              env: {
                HOME: home,
                SHELL: '/bin/zsh',
                USER: 'tester',
                PATH: `${machine.bin}:/usr/bin:/bin`,
                INSTALLER: script,
                PHOSPHOR_HOST_RELEASE_URL: `file://${release}`,
                PI_CODING_AGENT_DIR: machine.agentDir,
              },
            },
          )
          let stdout = '',
            stderr = ''
          command.stdout.on('data', (chunk) => {
            stdout += chunk
          })
          command.stderr.on('data', (chunk) => {
            stderr += chunk
          })
          command.on('error', reject)
          command.on('close', (status) => resolve({ status, stdout, stderr }))
        },
      )
      expect(child.status, child.stdout + child.stderr).toBe(0)
      expect(child.stdout).toContain(join(home, '.local/bin/phosphor'))
      expect(child.stdout.match(/Config, login, service and Tailscale ready/g)).toHaveLength(2)
      expect(existsSync(join(home, 'service-ready'))).toBe(true)
      expect(existsSync(join(home, 'route-ready'))).toBe(true)
      expect(control.calls.filter((call) => call.path.endsWith('/enrollments'))).toHaveLength(1)
      expect(child.stderr).not.toContain('ExperimentalWarning')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      machine.cleanup()
      await control.cleanup()
    }
  })
  it('keeps release bundles independent of TMPDIR and untracked machine files', () => {
    const probe = `phosphor-untracked-probe-${process.pid}.txt`
    expect(spawnSync('git', ['check-ignore', '-q', probe], { cwd: root }).status).toBe(1)
    const commands = join(dir, 'build-commands')
    mkdirSync(commands)
    const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
    // Ignore this working patch, but preserve real git handling of the one probe.
    writeFileSync(
      join(commands, 'git'),
      `#!/bin/sh
real='${realGit}'
[ "$1" = status ] || exec "$real" "$@"
status=$("$real" "$@") || exit "$?"
printf '%s\\n' "$status" | grep -F -x '?? ${probe}' || :
`,
      { mode: 0o755 },
    )
    const build = (name: string, shim: boolean) => {
      const temp = join(dir, `${name}-temp`)
      mkdirSync(temp)
      const output = join(dir, name)
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(output)},${JSON.stringify(cache)},${JSON.stringify({ version: '24.14.1', archives: { [target]: hash(readFileSync(join(cache, `node-v24.14.1-${target}.tar.gz`))) } })})`,
        {
          TMPDIR: temp,
          ...(shim ? { PATH: `${commands}:${process.env.PATH}` } : {}),
        },
      )
      return readFileSync(join(output, `phosphor-host-1.2.3-${target}.tar.gz`))
    }
    const clean = build('probe-before', true)
    try {
      writeFileSync(join(root, probe), 'Untracked machine data')
      expect(build('probe-after', true).equals(clean)).toBe(true)
    } finally {
      rmSync(join(root, probe), { force: true })
    }
    expect(build('real-other-temp', false).equals(bundle)).toBe(true)
  })
  it('carries no machine paths, source maps or sourceMappingURL in release text', () => {
    const user = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const userSegment = new RegExp(`[/\\\\]${user}(?![A-Za-z0-9_.-])`)
    const buildTemps = [tmpdir(), realpathSync(tmpdir())].flatMap((temp) =>
      ['phosphor-bundle-', 'phosphor-sign-'].map((prefix) => join(temp, prefix)),
    )
    const unpacked = join(dir, 'scan')
    mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', join(out, `phosphor-host-1.2.3-${target}.tar.gz`), '-C', unpacked])
    expect(readFileSync(join(unpacked, 'lib/phosphor.mjs'), 'utf8')).toContain(
      HOST_RELEASE_BASE_URL,
    )
    for (const file of readdirSync(unpacked, { recursive: true, encoding: 'utf8' })) {
      if (!lstatSync(join(unpacked, file)).isFile()) continue
      expect(file).not.toMatch(/\.map$/)
      const text = readFileSync(join(unpacked, file)).toString('utf8')
      if (text.includes('\0')) continue // Node is the only binary in the bundle.
      // `/tmp` alone is also prose; forbid the build's own temp folders instead.
      for (const forbidden of [root, dir, homedir(), ...buildTemps, 'sourceMappingURL'])
        expect(text, `${file} contains ${forbidden}`).not.toContain(forbidden)
      // A user name is also a word (CI's is `runner`); forbid it only as a path segment.
      expect(
        withoutPublicReleaseUrl(text),
        `${file} contains a path through the user name`,
      ).not.toMatch(userSegment)
    }
  })
  it('excludes only the exact public URL, never private username paths alongside it', () => {
    expect(withoutPublicReleaseUrl(HOST_RELEASE_BASE_URL)).toBe('')
    const user = userInfo().username.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const segment = new RegExp(`[/\\\\]${user}(?![A-Za-z0-9_.-])`)
    for (const path of [`/Users/${userInfo().username}/x`, `/home/${userInfo().username}/x`]) {
      const scanned = withoutPublicReleaseUrl(`${HOST_RELEASE_BASE_URL} ${path}`)
      expect(scanned).not.toContain(HOST_RELEASE_BASE_URL)
      expect(scanned).toContain(path)
      expect(scanned).toMatch(segment)
    }
  })
  it('recognizes both CLI entry points through paths containing spaces and percent signs', () => {
    const path = join(dir, 'entry % space')
    mkdirSync(path)
    execFileSync('ln', [
      '-s',
      join(root, 'tools/host-release/build-bundle.mjs'),
      join(path, 'build.mjs'),
    ])
    execFileSync('ln', [
      '-s',
      join(root, 'tools/host-release/manifest.mjs'),
      join(path, 'manifest.mjs'),
    ])
    for (const name of ['build', 'manifest']) {
      const entry = join(path, `${name}.mjs`)
      const result = spawnSync(process.execPath, [entry, '--unknown'], { encoding: 'utf8' })
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Unknown option')
      expect(
        node(
          `import {isEntryPoint} from './tools/host-release/common.mjs'; process.argv[1]=${JSON.stringify(entry)}; console.log(isEntryPoint(${JSON.stringify(pathToFileURL(entry).href)}))`,
        ).trim(),
      ).toBe('true')
    }
  })
  it('documents the implemented lock, updater and the manual Host Release workflow', () => {
    const docs = readFileSync(join(root, 'docs/host.md'), 'utf8')
    for (const rule of [
      'Any updater must',
      'recovery/',
      '.install-lock.retired.<own-pid>',
      'Retire the whole',
      'missing or malformed pid',
      'no program deletes the',
      'SIGKILL or power loss can leave a',
      'The manual **Host Release** workflow',
      'refuses to build while `HOST_RELEASE_KEYS` is',
      '## Updating',
      '## Uninstalling',
      '`phosphor update`',
      '--check',
      '--rollback',
      '`phosphor uninstall`',
    ])
      expect(docs).toContain(rule)
    expect(docs.replace(/\s+/g, ' ')).toContain(
      'SIGKILL or power loss can leave a pid-less lock or an abandoned `.install-lock/recovery` gate. Both require manual removal after confirming no installer or updater is running; the refusal message names `.install-lock`.',
    )
    expect(docs).not.toContain('signals are\nignored')
    expect(docs).not.toContain('The release workflow publishes')
  })
  it('is idempotent for the selected version and restores a missing launcher', () => {
    for (const missing of [false, true]) {
      const { result, home, old } = installPrepared((home) => {
        const root = join(home, '.local/lib/phosphor-host')
        mkdirSync(join(root, 'versions/1.2.3'))
        writeFileSync(join(root, 'versions/1.2.3/VERSION'), '1.2.3\n')
        writeFileSync(join(root, 'versions/1.2.3/marker'), 'keep')
        rmSync(join(root, 'current'))
        execFileSync('ln', ['-s', 'versions/1.2.3', join(root, 'current')])
        if (missing) rmSync(launcher(home))
        return {}
      })
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout).toContain('already installed')
      expect(readFileSync(join(old, 'versions/1.2.3/marker'), 'utf8')).toBe('keep')
      expect(execFileSync('readlink', [launcher(home)], { encoding: 'utf8' }).trim()).toBe(
        join(old, 'current/bin/phosphor'),
      )
    }
  })
  it('never merges existing version folders or replaces a nonsymlink current', () => {
    for (const kind of ['unselected', 'bad-version', 'current-directory', 'current-file']) {
      const { result, old } = installPrepared((home) => {
        const root = join(home, '.local/lib/phosphor-host')
        mkdirSync(join(root, 'versions/1.2.3'))
        writeFileSync(join(root, 'versions/1.2.3/VERSION'), 'wrong')
        if (kind !== 'unselected') {
          rmSync(join(root, 'current'))
          if (kind === 'bad-version')
            execFileSync('ln', ['-s', 'versions/1.2.3', join(root, 'current')])
          else if (kind === 'current-directory') mkdirSync(join(root, 'current'))
          else writeFileSync(join(root, 'current'), 'keep')
        }
        return {}
      })
      expect(result.status).not.toBe(0)
      expect(readFileSync(join(old, 'versions/1.2.3/VERSION'), 'utf8')).toBe('wrong')
      if (kind === 'unselected' || kind === 'bad-version') {
        expect(result.stderr).toContain(join(old, 'versions/1.2.3'))
        expect(result.stderr).toContain('phosphor update --rollback')
      }
    }
  })
  it('refuses foreign launchers by default and backs them up only with the flag', () => {
    for (const kind of ['file', 'symlink']) {
      const prepare = (home: string) => {
        rmSync(launcher(home))
        if (kind === 'file') writeFileSync(launcher(home), 'source launcher')
        else execFileSync('ln', ['-s', '/nonexistent/foreign', launcher(home)])
        return {}
      }
      const refused = installPrepared(prepare)
      expect(refused.result.status).not.toBe(0)
      expect(refused.result.stderr).toContain('--replace-launcher')
      expect(refused.result.stderr).toContain(launcher(refused.home))
      expect(readdirSync(join(refused.old, 'versions'))).toEqual(['old'])
      const replaced = installPrepared(prepare, ['--replace-launcher'])
      expect(replaced.result.status, replaced.result.stderr).toBe(0)
      expect(replaced.result.stdout).toContain('phosphor setup')
      const backup = `${launcher(replaced.home)}.before-release`
      if (kind === 'file') expect(readFileSync(backup, 'utf8')).toBe('source launcher')
      else
        expect(execFileSync('readlink', [backup], { encoding: 'utf8' }).trim()).toBe(
          '/nonexistent/foreign',
        )
      expect(execFileSync(launcher(replaced.home), ['version'], { encoding: 'utf8' })).toContain(
        '1.2.3',
      )
    }
  })
  it('refuses a launcher directory and existing backup even with the replacement flag', () => {
    for (const kind of ['directory', 'backup-file', 'backup-symlink']) {
      const { result, home, old } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          if (kind === 'directory') mkdirSync(launcher(home))
          else {
            writeFileSync(launcher(home), 'source launcher')
            if (kind === 'backup-file') writeFileSync(`${launcher(home)}.before-release`, 'keep')
            else execFileSync('ln', ['-s', '/missing', `${launcher(home)}.before-release`])
          }
          return {}
        },
        ['--replace-launcher'],
      )
      expect(result.status).not.toBe(0)
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      if (kind !== 'directory') expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
    }
  })
  it('recovers a dead install lock and refuses a live owner or malformed lock', () => {
    for (const owner of ['2147483647', String(process.pid), 'invalid', '0', '']) {
      const { result, old } = installPrepared((home) => {
        const lock = join(home, '.local/lib/phosphor-host/.install-lock')
        mkdirSync(lock)
        writeFileSync(join(lock, 'pid'), `${owner}\n`)
        return { KEEP_LOCK: owner === '2147483647' ? '0' : '1' }
      })
      if (owner === '2147483647') expect(result.status, result.stderr).toBe(0)
      else {
        expect(result.status).not.toBe(0)
        expect(result.stderr).toContain(join(old, '.install-lock'))
        expect(result.stderr).toContain('no install or update is running')
        expect(readFileSync(join(old, '.install-lock/pid'), 'utf8')).toBe(`${owner}\n`)
      }
    }
  })
  it('defers HUP, INT and TERM during acquisition, reclamation and publication', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      for (const phase of ['acquire', 'gate', 'retire', 'publish']) {
        const { result, old, home } = installPrepared(
          (home) => {
            const root = join(home, '.local/lib/phosphor-host')
            if (phase === 'gate' || phase === 'retire') {
              mkdirSync(join(root, '.install-lock'))
              writeFileSync(join(root, '.install-lock/pid'), '2147483647\n')
            }
            if (phase === 'publish') {
              rmSync(launcher(home))
              writeFileSync(launcher(home), 'source launcher')
            }
            const command = phase === 'acquire' || phase === 'gate' ? 'mkdir' : 'mv'
            const pattern = {
              acquire: '*"/.install-lock"',
              gate: '*"/.install-lock/recovery"',
              retire: '*"/.install-lock "*',
              publish: '*"/version "*',
            }[phase]
            const body = `case "$*" in ${pattern}) "$real" "$@" || exit "$?"; kill -${signal} "$PPID"; exit 0 ;; esac`
            return { PATH: hook(home, command, body) }
          },
          phase === 'publish' ? ['--replace-launcher'] : [],
        )
        expect(result.status, `${phase}: ${result.stderr}`).toBe(code)
        expect(result.stdout).not.toContain('Installed')
        expect(result.stdout).not.toContain('Next:')
        expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
        if (phase === 'publish') {
          expect(
            execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim(),
          ).toBe('versions/1.2.3')
          expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
          expect(readFileSync(`${launcher(home)}.before-release`, 'utf8')).toBe('source launcher')
        } else expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      }
    }
  })
  it('honors HUP, INT and TERM during owned-lock cleanup before printing success', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      const { result, old, home } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          writeFileSync(launcher(home), 'source launcher')
          return {
            PATH: hook(
              home,
              'mv',
              `case "$*" in *"/.install-lock "*) "$real" "$@" || exit "$?"; kill -${signal} "$PPID"; exit 0 ;; esac`,
            ),
          }
        },
        ['--replace-launcher'],
      )
      expect(result.status, result.stderr).toBe(code)
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/1.2.3',
      )
      expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
      expect(readFileSync(`${launcher(home)}.before-release`, 'utf8')).toBe('source launcher')
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(result.stdout).toBe('')
    }
  })
  it('honors TERM during cleanup of a failed publication and preserves the old install', () => {
    const { result, old, home } = installPrepared(
      (home) => {
        rmSync(launcher(home))
        writeFileSync(launcher(home), 'source launcher')
        return {
          PATH: hook(
            home,
            'mv',
            `case "$*" in
  *"/.install-lock "*) "$real" "$@" || exit "$?"; kill -TERM "$PPID"; exit 0 ;;
  *"/current "*) exit 1 ;;
esac`,
          ),
        }
      },
      ['--replace-launcher'],
    )
    expect(result.status, result.stderr).toBe(143)
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
    expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
    expect(existsSync(`${launcher(home)}.before-release`)).toBe(false)
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    expect(result.stdout).toBe('')
  })
  it('rolls back from filesystem state when a signaled publication rename returns failure after moving', () => {
    for (const [phase, signal, code] of [
      ['version', 'TERM', 143],
      ['backup', 'TERM', 143],
      ['launcher', 'TERM', 143],
      ['current', 'TERM', 143],
      ['current', 'HUP', 129],
      ['current', 'INT', 130],
    ] as const) {
      const { result, home, old } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          writeFileSync(launcher(home), 'source launcher')
          const pattern = {
            version: '*"/version "*',
            backup: '*"/bin/phosphor "*"/phosphor.before-release"',
            launcher: '*"/phosphor "*"/bin/phosphor"',
            current: '*"/current "*',
          }[phase]
          return {
            PATH: hook(
              home,
              'mv',
              `case "$*" in ${pattern}) "$real" "$@" || exit "$?"; kill -${signal} "$PPID"; exit 1 ;; esac`,
            ),
          }
        },
        ['--replace-launcher'],
      )
      expect(result.status, `${phase}: ${result.stderr}`).toBe(code)
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/old',
      )
      expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
      expect(existsSync(`${launcher(home)}.before-release`)).toBe(false)
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(result.stdout).not.toContain('Next:')
    }
  })
  it('trusts the filesystem when a signal interrupts launcher removal during rollback', () => {
    const { result, old, home } = installPrepared((home) => {
      rmSync(launcher(home))
      hook(home, 'mv', `case "$*" in *"/current "*) exit 1 ;; esac`)
      return {
        PATH: hook(
          home,
          'rm',
          `case "$*" in *"/.local/bin/phosphor") "$real" "$@"; kill -TERM "$PPID"; exit 0 ;; esac`,
        ),
      }
    })
    expect(result.status, result.stderr).toBe(143)
    expect(result.stderr).not.toContain('may have completed')
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(existsSync(launcher(home))).toBe(false)
    expect(result.stdout).toBe('')
  })
  it('never deletes the selected version when a selection read fails during cleanup', () => {
    const { result, old } = installPrepared((home) => {
      hook(
        home,
        'mv',
        `case "$*" in *"/current "*) "$real" "$@" || exit "$?"; : > '${home}/moved'; exit 1 ;; esac`,
      )
      return {
        PATH: hook(
          home,
          'readlink',
          `if [ -e '${home}/moved' ] && [ ! -e '${home}/read' ]; then : > '${home}/read'; exit 1; fi`,
        ),
      }
    })
    expect(result.status, result.stderr).toBe(1)
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/1.2.3',
    )
    expect(readdirSync(join(old, 'versions')).sort()).toEqual(['1.2.3', 'old'])
    expect(existsSync(join(old, 'versions/1.2.3/VERSION'))).toBe(true)
  })
  it('protects lock mkdir and retirement from a signal sent to both parent and child', () => {
    for (const phase of ['acquire', 'retire']) {
      let release = ''
      const { result, old, home } = installPrepared((home, folder) => {
        release = folder
        if (phase === 'retire') {
          const lock = join(home, '.local/lib/phosphor-host/.install-lock')
          mkdirSync(lock)
          writeFileSync(join(lock, 'pid'), '2147483647\n')
        }
        const pattern = phase === 'acquire' ? '*"/.install-lock"' : '*"/.install-lock "*'
        return {
          PATH: hook(
            home,
            phase === 'acquire' ? 'mkdir' : 'mv',
            `case "$*" in ${pattern}) "$real" "$@" || exit "$?"; kill -INT "$PPID"; kill -INT "$$"; exit 0 ;; esac`,
          ),
        }
      })
      expect(result.status, `${phase}: ${result.stderr}`).toBe(130)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/old',
      )
      const next = rerun(home, release)
      expect(next.status, next.stderr).toBe(0)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('protects publication mv from a signal sent to both parent and child', () => {
    const { result, old, home } = installPrepared((home) => ({
      PATH: hook(
        home,
        'mv',
        `case "$*" in *"/current "*) "$real" "$@" || exit "$?"; kill -INT "$PPID"; kill -INT "$$"; exit 0 ;; esac`,
      ),
    }))
    expect(result.status, result.stderr).toBe(130)
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/1.2.3',
    )
    expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    expect(result.stdout).not.toContain('Next:')
  })
  it('retains complete bundles and the backup if restoration or roll-forward fails', () => {
    for (const failure of ['launcher', 'current', 'forward']) {
      const { result, old, home } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          writeFileSync(launcher(home), 'source launcher')
          return {
            PATH: hook(
              home,
              'mv',
              `case "$*" in
  *"/restore-current "*) [ '${failure}' != current ] || exit 1 ;;
  *"/phosphor.before-release "*"/bin/phosphor") [ '${failure}' = current ] || exit 1 ;;
  *"/forward-current "*) [ '${failure}' != forward ] || exit 1 ;;
  *"/current "*) "$real" "$@" || exit "$?"; kill -TERM "$PPID"; exit 1 ;;
esac`,
            ),
          }
        },
        ['--replace-launcher'],
      )
      expect(result.status, result.stderr).toBe(143)
      expect(result.stderr).toContain('may have completed; rerunning the installer is safe')
      expect(readFileSync(`${launcher(home)}.before-release`, 'utf8')).toBe('source launcher')
      expect(execFileSync('readlink', [launcher(home)], { encoding: 'utf8' }).trim()).toBe(
        join(old, 'current/bin/phosphor'),
      )
      expect(
        existsSync(join(old, 'current/marker')) ||
          existsSync(join(old, 'current/lib/phosphor.mjs')),
      ).toBe(true)
      expect(existsSync(join(old, 'versions/1.2.3/lib/phosphor.mjs'))).toBe(true)
      if (failure !== 'forward')
        expect(execFileSync(launcher(home), ['version'], { encoding: 'utf8' })).toContain('1.2.3')
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('releases a held recovery gate on a signaled failure so the next installer can reclaim', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      let release = ''
      const { result, home, old } = installPrepared((home, folder) => {
        release = folder
        const lock = join(home, '.local/lib/phosphor-host/.install-lock')
        mkdirSync(lock)
        writeFileSync(join(lock, 'pid'), '2147483647\n')
        return {
          KEEP_LOCK: '1',
          PATH: hook(
            home,
            'mv',
            `case "$*" in *"/.install-lock "*) kill -${signal} "$PPID"; exit 1 ;; esac`,
          ),
        }
      })
      expect(result.status, result.stderr).toBe(code)
      expect(readdirSync(join(old, '.install-lock'))).toEqual(['pid'])
      expect(readdirSync(old).sort()).toEqual(['.install-lock', 'current', 'versions'])
      expect(rerun(home, release).status).toBe(0)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('sweeps only dead exact non-symlink retired folders, at most sixteen per acquisition', () => {
    const { result, old, home } = installPrepared((home) => {
      const root = join(home, '.local/lib/phosphor-host')
      for (let i = 0; i < 17; i++) {
        const retired = join(root, `.install-lock.retired.${2147483600 + i}`)
        mkdirSync(join(retired, 'recovery'), { recursive: true })
        writeFileSync(join(retired, 'pid'), '2147483647\n')
      }
      mkdirSync(join(root, `.install-lock.retired.${process.pid}`))
      mkdirSync(join(root, '.install-lock.retired.2147483647.extra'))
      mkdirSync(join(home, 'outside'))
      writeFileSync(join(home, 'outside/pid'), 'keep')
      execFileSync('ln', [
        '-s',
        join(home, 'outside'),
        join(root, '.install-lock.retired.2147483647'),
      ])
      return {}
    })
    expect(result.status, result.stderr).toBe(0)
    const candidates = [
      `.install-lock.retired.${process.pid}`,
      ...Array.from({ length: 17 }, (_, i) => `.install-lock.retired.${2147483600 + i}`),
    ]
      .sort()
      .slice(0, 16)
    for (let i = 0; i < 17; i++) {
      const name = `.install-lock.retired.${2147483600 + i}`
      expect(existsSync(join(old, name)), name).toBe(!candidates.includes(name))
    }
    expect(existsSync(join(old, `.install-lock.retired.${process.pid}`))).toBe(true)
    expect(existsSync(join(old, '.install-lock.retired.2147483647.extra'))).toBe(true)
    expect(readFileSync(join(home, 'outside/pid'), 'utf8')).toBe('keep')
  })
  it('leaves non-exact retired names byte-for-byte untouched without counting them toward the sweep', () => {
    const names = [
      'extra.2147483647',
      'keep.2147483647',
      '0123',
      ...Array.from({ length: 16 }, (_, i) => `0${2147483600 + i}`),
      '',
      '21474836470',
    ]
    const contents = Buffer.from('retired pid contents\n\0unchanged')
    const { result, old } = installPrepared((home) => {
      const root = join(home, '.local/lib/phosphor-host')
      for (const suffix of [...names, '2147483647']) {
        const retired = join(root, `.install-lock.retired.${suffix}`)
        mkdirSync(join(retired, 'recovery'), { recursive: true })
        writeFileSync(join(retired, 'pid'), contents)
      }
      return {}
    })
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(join(old, '.install-lock.retired.2147483647'))).toBe(false)
    for (const suffix of names) {
      const retired = join(old, `.install-lock.retired.${suffix}`)
      expect(readdirSync(retired).sort()).toEqual(['pid', 'recovery'])
      expect(readFileSync(join(retired, 'pid')).equals(contents)).toBe(true)
      expect(readdirSync(join(retired, 'recovery'))).toEqual([])
    }
  })
  it('does not strand a lock when two reclaimers read the same dead pid before retirement', () => {
    let release = ''
    const wait = `await_file() { i=0; while [ ! -e "$1" ]; do i=$((i+1)); [ "$i" -le 1000 ] || exit 91; sleep 0.01; done; }`
    const { result, home, old } = installPrepared((home, folder) => {
      release = folder
      const lock = join(home, '.local/lib/phosphor-host/.install-lock')
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), '2147483647\n')
      hook(
        home,
        'mkdir',
        `${wait}
case "$*" in *"/.install-lock/recovery")
  if [ "\${RACER:-A}" = B ]; then
    touch "$HOME/b-ready"; await_file "$HOME/retired"
    "$real" "$@"; code=$?
    touch "$HOME/b-gate"
    [ "$code" != 0 ] || await_file "$HOME/a-rmdir"
    exit "$code"
  fi
  (RACER=B sh '${script}' 1.2.3 > "$HOME/b-output" 2> "$HOME/b-error"; echo "$?" > "$HOME/b-status") &
  await_file "$HOME/b-ready"
;; esac`,
      )
      hook(
        home,
        'mv',
        `${wait}
case "$*" in *"/.install-lock "*)
  "$real" "$@" || exit "$?"
  touch "$HOME/retired"; await_file "$HOME/b-gate"; exit 0
;; esac`,
      )
      const path = hook(
        home,
        'rmdir',
        `${wait}
case "$*" in
  *"/.install-lock/recovery") "$real" "$@" || exit "$?"; touch "$HOME/retired"; await_file "$HOME/b-gate"; exit 0 ;;
  *"/.install-lock") "$real" "$@"; code=$?; touch "$HOME/a-rmdir"; exit "$code" ;;
esac`,
      )
      return { PATH: path }
    })
    expect(result.status, result.stderr).toBe(0)
    // spawnSync waits for B too, since B shares the captured pipes.
    expect(readFileSync(join(home, 'b-status'), 'utf8').trim()).toBe('1')
    expect(readFileSync(join(home, 'b-error'), 'utf8')).toContain('Install lock:')
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    const third = rerun(home, release)
    expect(third.status, third.stderr).toBe(0)
    expect(third.stdout).toContain('already installed')
  })
  it('emits the contract protocols and signs a complete three-target manifest', () => {
    const output = join(dir, 'manifest-output')
    mkdirSync(output)
    for (const target of ['linux-x64', 'linux-arm64', 'darwin-arm64'])
      writeFileSync(join(output, `phosphor-host-1.2.3-${target}.tar.gz`), 'test artifact')
    node(
      `import {makeManifest} from './tools/host-release/manifest.mjs'; makeManifest(${JSON.stringify(output)})`,
      { HOST_RELEASE_SIGNING_KEY: privateKey },
    )
    const path = join(output, 'phosphor-host-1.2.3.manifest.json')
    const manifest = verifyReleaseManifest(
      readFileSync(path),
      readFileSync(`${path}.sig`, 'utf8'),
      [{ id: 'test', publicKey }],
    )
    expect(manifest.protocols).toEqual([HOST_PROTOCOL_VERSION])
    expect(manifest.artifacts).toHaveLength(3)
    for (const name of readdirSync(output))
      expect(readFileSync(join(output, name)).includes(Buffer.from(privateKey))).toBe(false)
  })
  it('keeps the checked-in installer generated from the pinned key source', () => {
    const generated = join(dir, 'generated-install.sh')
    node(
      `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(generated)})`,
    )
    expect(
      readFileSync(generated).equals(readFileSync(join(root, 'tools/host-release/install.sh'))),
    ).toBe(true)
  })
  it('refuses wrong Node archive hash before extraction or build', () => {
    expect(() =>
      node(
        `import {nodeArchive} from './tools/host-release/build-bundle.mjs'; await nodeArchive(${JSON.stringify(target)},${JSON.stringify(cache)})`,
      ),
    ).toThrow(/Node archive hash mismatch/)
  })
  it('refuses changed manifest, wrong namespace, other key, artifact hash and size without changing existing install', () => {
    const cases = [
      () => install(undefined, undefined, undefined, true),
      () => install(undefined, 'wrong'),
      () => install(undefined, undefined, 'other'),
      () => install(undefined, undefined, undefined, undefined, undefined, undefined, 'sha256'),
      () =>
        install((m) => {
          const a = m.artifacts[0]
          if (a) a.sha256 = '0'.repeat(64)
        }),
      () =>
        install((m) => {
          const a = m.artifacts[0]
          if (a) a.bytes--
        }),
      () =>
        install((m) => {
          const a = m.artifacts[0]
          if (a) a.bytes++
        }),
    ]
    for (const run of cases) {
      const { result, old } = run()
      expect(result.status).not.toBe(0)
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
        'versions/old',
      )
      expect(existsSync(join(old, '.install'))).toBe(false)
    }
  })
  it('refuses unsafe signed versions and artifact paths', () => {
    for (const version of ['../1.2.3', '1/2/3', '1.2.3\n', '01.2.3', '1.2.4']) {
      const { result } = install((m) => {
        m.version = version
      })
      expect(result.status).not.toBe(0)
    }
    const { result } = install((m) => {
      const a = m.artifacts[0]
      if (a) a.file = '../escape'
    })
    expect(result.status).not.toBe(0)
  })
  it('rejects signed malformed shapes, duplicate targets, unknown fields and limits', () => {
    const changes = [
      (m: ReturnType<typeof metadata>) => {
        Reflect.set(m, 'schema', '1')
      },
      (m: ReturnType<typeof metadata>) => {
        Reflect.set(m, 'extra', true)
      },
      (m: ReturnType<typeof metadata>) => {
        Reflect.set(m, 'protocols', ['1'])
      },
      (m: ReturnType<typeof metadata>) => {
        m.protocols = []
      },
      (m: ReturnType<typeof metadata>) => {
        m.protocols = [1, 1]
      },
      (m: ReturnType<typeof metadata>) => {
        m.protocols = [65536]
      },
      (m: ReturnType<typeof metadata>) => {
        m.artifacts.push(...m.artifacts)
      },
      (m: ReturnType<typeof metadata>) => {
        const a = m.artifacts[0]
        if (a) a.bytes = 268435457
      },
    ]
    for (const change of changes) expect(install(change).result.status).not.toBe(0)
  })
  it('rejects signed JSON with quoted array delimiters', () => {
    for (const change of [
      (json: string) => json.replace('2\n  ]', '2\n  "]"'),
      (json: string) => json.replace('}\n  ]', '}\n  "]"'),
      (json: string) => json.replace('1,\n    2', '1 ","\n    2'),
    ]) {
      const { result } = install(
        (m) => {
          m.protocols = [1, 2]
        },
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        change,
      )
      expect(result.status).not.toBe(0)
    }
  })
  it('refuses signed archive traversal and symlinks before extracting anything', () => {
    const original = bundle
    try {
      for (const kind of ['traversal', 'symlink']) {
        const tar = gunzipSync(original)
        const header = tar.subarray(0, 512)
        if (kind === 'traversal') {
          header.fill(0, 0, 100)
          header.write('../escaped', 0, 'ascii')
        } else {
          header[156] = 50
          header.write('outside-target', 157, 'ascii')
        }
        header.fill(32, 148, 156)
        header.write(
          header
            .reduce((a, b) => a + b, 0)
            .toString(8)
            .padStart(6, '0') + '\0 ',
          148,
          'ascii',
        )
        bundle = gzipSync(tar)
        const { result, old, home } = install(
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          (home) => {
            const commands = join(home, 'commands')
            mkdirSync(commands)
            const realTar = execFileSync('sh', ['-c', 'command -v tar'], {
              encoding: 'utf8',
            }).trim()
            writeFileSync(
              join(commands, 'tar'),
              `#!/bin/sh\n[ "$1" != '-xzf' ] || touch "$HOME/extracted"\nexec ${realTar} "$@"\n`,
              { mode: 0o755 },
            )
            return { PATH: `${commands}:${process.env.PATH}` }
          },
        )
        expect(result.status).not.toBe(0)
        expect(existsSync(join(home, 'extracted'))).toBe(false)
        expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
      }
    } finally {
      bundle = original
    }
  })
  it('refuses directory symlinks outside its allowed install tree', () => {
    const { result, home } = install(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (home) => {
        const outside = join(home, 'outside')
        mkdirSync(outside)
        rmSync(join(home, '.local/bin'), { recursive: true })
        execFileSync('ln', ['-s', outside, join(home, '.local/bin')])
        return {}
      },
    )
    expect(result.status).not.toBe(0)
    expect(readdirSync(join(home, 'outside'))).toEqual([])
  })
  it('rolls back the launcher and version when current publication fails', () => {
    const { result, home, old } = install(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      (home) => {
        const commands = join(home, 'commands')
        mkdirSync(commands)
        const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()
        writeFileSync(
          join(commands, 'mv'),
          `#!/bin/sh\ncase "$*" in *'/current '*) exit 1 ;; esac\nexec ${realMv} "$@"\n`,
          { mode: 0o755 },
        )
        return { PATH: `${commands}:${process.env.PATH}` }
      },
    )
    expect(result.status).not.toBe(0)
    expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    expect(
      execFileSync('readlink', [join(home, '.local/bin/phosphor')], { encoding: 'utf8' }).trim(),
    ).toBe(join(old, 'current/bin/phosphor'))
    expect(execFileSync('readlink', [join(old, 'current')], { encoding: 'utf8' }).trim()).toBe(
      'versions/old',
    )
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
  })
  it('restores a foreign launcher or missing launcher when current publication fails', () => {
    for (const foreign of [true, false]) {
      const { result, home, old } = installPrepared(
        (home) => {
          rmSync(launcher(home))
          if (foreign) writeFileSync(launcher(home), 'source launcher')
          const commands = join(home, 'commands')
          mkdirSync(commands)
          const realMv = execFileSync('sh', ['-c', 'command -v mv'], { encoding: 'utf8' }).trim()
          writeFileSync(
            join(commands, 'mv'),
            `#!/bin/sh\ncase "$*" in *'/current '*) exit 1 ;; esac\nexec ${realMv} "$@"\n`,
            { mode: 0o755 },
          )
          return { PATH: `${commands}:${process.env.PATH}` }
        },
        foreign ? ['--replace-launcher'] : [],
      )
      expect(result.status).not.toBe(0)
      if (foreign) expect(readFileSync(launcher(home), 'utf8')).toBe('source launcher')
      else expect(existsSync(launcher(home))).toBe(false)
      expect(existsSync(`${launcher(home)}.before-release`)).toBe(false)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
      expect(readdirSync(join(old, 'versions'))).toEqual(['old'])
    }
  })
  it('cleans up its owned install lock on HUP, INT and TERM', () => {
    for (const [signal, code] of [
      ['HUP', 129],
      ['INT', 130],
      ['TERM', 143],
    ] as const) {
      const { result, old } = installPrepared((home) => {
        const commands = join(home, 'commands')
        mkdirSync(commands)
        const realMktemp = execFileSync('sh', ['-c', 'command -v mktemp'], {
          encoding: 'utf8',
        }).trim()
        writeFileSync(
          join(commands, 'mktemp'),
          `#!/bin/sh\ncase "$*" in *'/phosphor-host/.install.'*) kill -${signal} "$PPID"; exit 1 ;; esac\nexec ${realMktemp} "$@"\n`,
          { mode: 0o755 },
        )
        return { PATH: `${commands}:${process.env.PATH}` }
      })
      expect(result.status, result.stderr).toBe(code)
      expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    }
  })
  it('cleans up its environment-only signing key on success and failure', () => {
    const temp = join(dir, 'sign-tmp')
    mkdirSync(temp)
    const env = { HOST_RELEASE_SIGNING_KEY: privateKey, TMPDIR: temp }
    const output = node(
      `import {signManifest} from './tools/host-release/manifest.mjs'; signManifest(Buffer.from('test'))`,
      env,
    )
    expect(output).not.toContain(privateKey.trim())
    expect(readdirSync(temp)).toEqual([])
    expect(() =>
      node(
        `import {signManifest} from './tools/host-release/manifest.mjs'; signManifest(Buffer.from('test'))`,
        { ...env, HOST_RELEASE_SIGNING_KEY: 'invalid-test-key' },
      ),
    ).toThrow(/Release signing failed/)
    expect(readdirSync(temp)).toEqual([])
  })
  it('signs with a key whose secret store dropped the final newline or used CRLF', () => {
    const sign = `import {signManifest} from './tools/host-release/manifest.mjs'; process.stdout.write(signManifest(Buffer.from('test')).toString('utf8'))`
    for (const key of [privateKey.trimEnd(), privateKey.trimEnd().replace(/\n/g, '\r\n')]) {
      expect(node(sign, { HOST_RELEASE_SIGNING_KEY: key })).toContain('BEGIN SSH SIGNATURE')
    }
  })
  it.runIf(process.env.PHOSPHOR_HOST_RELEASE_NETWORK === '1')(
    'checks the official pinned archive on this platform',
    async () => {
      const real = join(dir, 'official')
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(real)})`,
      )
      const second = join(dir, 'official-second')
      node(
        `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)},${JSON.stringify(second)},${JSON.stringify(join(real, '.node-cache'))})`,
      )
      const file = `phosphor-host-1.2.3-${target}.tar.gz`
      const official = readFileSync(join(real, file))
      expect(readFileSync(join(second, file)).equals(official)).toBe(true)
      const fake = bundle
      try {
        bundle = official
        const { result, home } = install()
        expect(result.status, result.stderr).toBe(0)
        expect(
          execFileSync(join(home, '.local/bin/phosphor'), ['version'], {
            encoding: 'utf8',
            env: { HOME: home, PATH: '/usr/bin:/bin' },
          }),
        ).toContain('1.2.3')
      } finally {
        bundle = fake
      }
    },
    180000,
  )
})

import { randomBytes } from 'node:crypto'
import type * as FsPromises from 'node:fs/promises'
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:fs/promises', { spy: true })
vi.mock('../config/load', { spy: true })
import { loadHostConfig } from '../config/load'
import { validateHostConfig, type HostConfigV1 } from '../config/schema'
import { renderSetup, runSetup, type SetupContext } from './setup'

let dir: string
let context: SetupContext
let bin: string
let repository: string
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'phosphor-setup-')))
  bin = join(dir, 'bin')
  repository = join(dir, 'project')
  const home = join(dir, 'home')
  await Promise.all([bin, repository, home].map((path) => mkdir(path, { mode: 0o700 })))
  context = {
    configPath: join(dir, 'config', 'config.json'),
    cwd: repository,
    env: { HOME: home, PATH: bin },
    home,
    uid: process.getuid?.(),
    platform: 'linux',
    hostname: 'test-host',
    nodeVersion: '22.22.3',
    defaultResourceRoot: dir,
    repositories: [repository],
    // Generous: a full parallel suite can delay a fake executable past a second.
    probeTimeoutMs: 15_000,
    tailscale: { which: async () => null, probe: vi.fn() },
  }
  await executable('pi', 'echo 1.2.0')
})
afterEach(async () => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

async function executable(name: string, body: string, folder = bin): Promise<string> {
  await mkdir(folder, { recursive: true, mode: 0o700 })
  const path = join(folder, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  return path
}
async function nodePi(nodeFolder = bin) {
  const script = join(dir, 'cli.js')
  await writeFile(script, '#!/usr/bin/env node\n', { mode: 0o700 })
  await rm(join(bin, 'pi'))
  await symlink(script, join(bin, 'pi'))
  return executable(
    'node',
    'if [ "$1" = --version ]; then echo v22.22.3; else echo 1.2.0; fi',
    nodeFolder,
  )
}
async function saved(): Promise<HostConfigV1> {
  const loaded = await loadHostConfig(context.configPath, context.uid)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error('config did not load')
  expect(validateHostConfig(loaded.config).ok).toBe(true)
  return loaded.config
}
async function oldConfig(extra: Partial<HostConfigV1> = {}) {
  await mkdir(dirname(context.configPath), { mode: 0o700, recursive: true })
  await writeFile(
    context.configPath,
    JSON.stringify({
      version: 1,
      pi: { executable: join(bin, 'pi') },
      repositories: [repository],
      ...extra,
    }),
    { mode: 0o600 },
  )
}
async function nothingWritten() {
  expect(await lstat(context.configPath).catch(() => null)).toBeNull()
}

describe('setup detection', () => {
  it('pins the real folder of a node found only through a per-shell PATH link', async () => {
    const nodes = join(dir, 'versions', 'node')
    await nodePi(nodes)
    const shell = join(dir, 'multishell')
    await mkdir(shell, { mode: 0o700 })
    await symlink(nodes, join(shell, 'bin'))
    context.env = { ...context.env, PATH: `${bin}:${join(shell, 'bin')}` }
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await saved()).pi).toEqual({ executable: join(bin, 'pi'), node: join(nodes, 'node') })
  })
  it('pins the real folder behind a per-shell PATH link, keeping each name', async () => {
    // fnm's multishell: a link per shell to the version's bin folder, gone at logout.
    await nodePi()
    await executable('claude', 'exit 0', join(dir, 'versions', 'tools'))
    const shell = join(dir, 'multishell')
    await mkdir(shell, { mode: 0o700 })
    await symlink(bin, join(shell, 'bin'))
    await symlink(join(dir, 'versions', 'tools'), join(shell, 'tools'))
    context.env = { ...context.env, PATH: `${join(shell, 'bin')}:${join(shell, 'tools')}` }
    expect((await runSetup(context)).exitCode).toBe(0)
    const config = await saved()
    expect(config.pi).toEqual({ executable: join(bin, 'pi'), node: join(bin, 'node') })
    expect(config.environment?.path).toEqual([join(dir, 'versions', 'tools')])
    expect(JSON.stringify(config)).not.toContain('multishell')
  })

  it('pins a direct executable without node and prints paths, version and next step', async () => {
    const report = await runSetup(context)
    expect(report.exitCode).toBe(0)
    expect((await saved()).pi).toEqual({ executable: join(bin, 'pi') })
    expect(renderSetup(report)).toContain(`pi  ${bin}/pi (pi 1.2.0)`)
    expect(renderSetup(report)).toContain('claude  not found')
    expect(report.repositories).toEqual([repository])
    expect(renderSetup(report)).toContain(
      'not a git repository: sessions may start in any folder inside it',
    )
    expect(renderSetup(report).endsWith('next: phosphor setup\n')).toBe(true)
    expect(report).toMatchObject({ next: 'phosphor setup', pi: { version: '1.2.0' } })
  })
  it('pins a Node-script symlink as found, with node beside it', async () => {
    const node = await nodePi()
    const other = await executable('node', 'echo v1.0.0', join(dir, 'other'))
    context.env.PATH = `${dirname(other)}:${bin}`
    const report = await runSetup(context)
    expect(report.exitCode).toBe(0)
    expect((await saved()).pi).toEqual({ executable: join(bin, 'pi'), node })
    expect(renderSetup(report)).toContain(`node  ${node} (node 22.22.3)`)
  })
  it('falls back to node on PATH', async () => {
    const node = await nodePi(join(dir, 'node-bin'))
    context.env.PATH = `${bin}:${dirname(node)}`
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await saved()).pi.node).toBe(node)
  })
  it('honors relative --pi and --node overrides', async () => {
    const node = await nodePi(join(dir, 'chosen'))
    context.pi = '../cli.js'
    context.node = '../chosen/node'
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await saved()).pi).toEqual({ executable: join(dir, 'cli.js'), node })
  })
  it('pins a shell wrapper on PATH without node, even when --node is given', async () => {
    context.node = '/missing/node'
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await saved()).pi).toEqual({ executable: join(bin, 'pi') })
  })
  it('exits 69 with the install command and writes nothing when pi is absent', async () => {
    await rm(join(bin, 'pi'))
    const report = await runSetup(context)
    expect(report.exitCode).toBe(69)
    expect(renderSetup(report)).toContain(
      'install pi first: npm install -g @earendil-works/pi-coding-agent',
    )
    await nothingWritten()
  })
  it('keeps credential values out of probe failures in text and JSON', async () => {
    const secret = randomBytes(32).toString('hex')
    context.env.ANTHROPIC_API_KEY = secret
    await executable('pi', 'echo "$ANTHROPIC_API_KEY" >&2; exit 1')
    const report = await runSetup(context)
    expect(report.exitCode).toBe(69)
    expect(renderSetup(report)).toContain('[redacted]')
    expect(renderSetup(report)).not.toContain(secret)
    expect(JSON.stringify(report)).not.toContain(secret)
    await nothingWritten()
  })

  it.each([
    'missing pi',
    'old pi',
    'pi fails',
    'missing node',
    'old node',
    'node fails',
    'no node',
  ])('writes nothing for %s', async (scenario) => {
    if (scenario === 'missing pi') context.pi = '/nonexistent/pi'
    if (scenario === 'old pi') await executable('pi', 'echo 0.1.0')
    if (scenario === 'pi fails') await executable('pi', 'exit 1')
    if (scenario.includes('node')) {
      const node = await nodePi()
      if (scenario === 'missing node') context.node = '/nonexistent/node'
      if (scenario === 'old node') await executable('node', 'echo v18.0.0')
      if (scenario === 'node fails') await executable('node', 'exit 1')
      if (scenario === 'no node') await rm(node)
    }
    const report = await runSetup(context)
    expect(report.exitCode).toBe(scenario === 'no node' ? 78 : 69)
    expect(renderSetup(report)).toContain('FAIL')
    await nothingWritten()
  })
})

describe('setup repositories and PATH', () => {
  it('resolves explicit repeated relative repositories and deduplicates them', async () => {
    const other = join(dir, 'other')
    await mkdir(other)
    context.repositories = ['.', '../other', '.']
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await saved()).repositories).toEqual([repository, other])
  })
  it('rejects a discovered home git top level', async () => {
    await executable('git', `printf '%s\\n' '${context.home}'`)
    context.repositories = undefined
    expect((await runSetup(context)).exitCode).toBe(64)
    await nothingWritten()
  })

  it('uses the git top level rather than cwd', async () => {
    await executable(
      'git',
      `if [ "$4" = --show-toplevel ]; then printf '%s\\n' '${repository}'; else exit 0; fi`,
    )
    const nested = join(repository, 'nested')
    await mkdir(nested)
    context.cwd = nested
    context.repositories = undefined
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await saved()).repositories).toEqual([repository])
  })
  it('writes a valid empty configuration outside git', async () => {
    await executable('git', 'exit 1')
    context.repositories = []
    const report = await runSetup(context)
    expect(report.exitCode).toBe(0)
    expect(renderSetup(report)).toContain(
      'Desktop folder picker or phosphor setup --repository PATH',
    )
    expect((await saved()).repositories).toEqual([])
  })
  it.each(['/', 'home', 'home parent', 'link to home', 'missing', 'file'])(
    'refuses repository %s',
    async (scenario) => {
      const path =
        scenario === '/'
          ? '/'
          : scenario === 'home'
            ? context.home
            : scenario === 'home parent'
              ? dir
              : join(dir, scenario)
      if (scenario === 'link to home') await symlink(context.home, path)
      if (scenario === 'file') await writeFile(path, '')
      context.repositories = [path]
      expect((await runSetup(context)).exitCode).toBe(
        ['missing', 'file'].includes(scenario) ? 69 : 64,
      )
      await nothingWritten()
    },
  )
  it('accepts 64 repositories and rejects 65 before probing', async () => {
    context.repositories = Array.from({ length: 64 }, () => repository)
    expect((await runSetup(context)).exitCode).toBe(0)
    context.replace = true
    context.repositories.push(repository)
    const before = await readFile(context.configPath)
    expect((await runSetup(context)).exitCode).toBe(64)
    expect(await readFile(context.configPath)).toEqual(before)
  })
  it.each([true, false])(
    'adds claude/git directories only when missing from the built PATH (beside node: %s)',
    async (beside) => {
      await nodePi()
      const folder = beside ? bin : join(dir, 'tools')
      await executable('claude', 'exit 0', folder)
      await executable('git', 'exit 1', folder)
      context.env.PATH = `${bin}:${folder}:${folder}`
      const report = await runSetup(context)
      expect(report.exitCode).toBe(0)
      expect(report.claude).toBe('found')
      expect((await saved()).environment?.path).toEqual(beside ? [] : [folder])
    },
  )
})

describe('setup existing config and permissions', () => {
  it('leaves a valid existing config bytes and mtime untouched without replace', async () => {
    await oldConfig({ environment: { path: [bin] } })
    const before = await readFile(context.configPath)
    const mtime = (await stat(context.configPath)).mtimeMs
    const report = await runSetup(context)
    expect(report.exitCode).toBe(0)
    expect(renderSetup(report)).toContain(`extra PATH  ${bin}`)
    expect(report.changed).toBe(false)
    expect(await readFile(context.configPath)).toEqual(before)
    expect((await stat(context.configPath)).mtimeMs).toBe(mtime)
  })
  it('refuses a broken existing config without replace, with safe errors only', async () => {
    await oldConfig()
    await writeFile(context.configPath, '{"private":"not-json')
    const before = await readFile(context.configPath)
    const report = await runSetup(context)
    expect(report.exitCode).toBe(78)
    expect(renderSetup(report)).toContain('the config is not usable; rerun with --replace')
    expect(renderSetup(report)).not.toContain('not-json')
    expect(await readFile(context.configPath)).toEqual(before)
  })
  it('keeps the approved old fields on replace, but redetects pi, repositories and PATH', async () => {
    const kept = {
      hostId: 'local-id',
      contextBudget: '400k',
      agentDirectives: { laneCharter: false },
      accounts: null,
      control: { url: 'https://example.com' },
      resourceRoot: dir,
      environment: { pass: ['LANG'], path: [dir] },
    }
    await oldConfig(kept)
    context.replace = true
    expect((await runSetup(context)).exitCode).toBe(0)
    expect(await saved()).toMatchObject({ ...kept, environment: { pass: ['LANG'], path: [dir] } })
  })
  it('replaces a broken file and says so', async () => {
    await oldConfig()
    await writeFile(context.configPath, 'broken')
    context.replace = true
    const report = await runSetup(context)
    expect(report.exitCode).toBe(0)
    expect(renderSetup(report)).toContain('old config is not usable; replacing it')
    await saved()
  })
  it('replaces a symlink itself, leaving its target untouched', async () => {
    await oldConfig({ hostId: 'keep-me' })
    const target = join(dirname(context.configPath), 'original.json')
    await writeFile(target, await readFile(context.configPath), { mode: 0o600 })
    await rm(context.configPath)
    await symlink(target, context.configPath)
    const before = await readFile(target)
    context.replace = true
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await lstat(context.configPath)).isSymbolicLink()).toBe(false)
    expect(await readFile(target)).toEqual(before)
    expect((await saved()).hostId).toBe('keep-me')
  })
  it('replaces a dangling link, and never labels it already set up', async () => {
    await mkdir(dirname(context.configPath), { mode: 0o700 })
    const target = join(dir, 'missing.json')
    await symlink(target, context.configPath)
    expect((await runSetup(context)).exitCode).toBe(78)
    expect((await lstat(context.configPath)).isSymbolicLink()).toBe(true)
    context.replace = true
    expect((await runSetup(context)).exitCode).toBe(0)
    expect(await lstat(target).catch(() => null)).toBeNull()
    await saved()
  })

  it('refuses an existing directory at the config path without replace', async () => {
    await mkdir(context.configPath, { recursive: true, mode: 0o700 })
    expect((await runSetup(context)).exitCode).toBe(78)
    expect((await stat(context.configPath)).isDirectory()).toBe(true)
  })

  it('reports an internal error if the written config cannot be loaded', async () => {
    vi.mocked(loadHostConfig).mockResolvedValueOnce({
      ok: false,
      path: context.configPath,
      errors: [{ pointer: '', message: 'post-write load failed' }],
    })
    const report = await runSetup(context)
    expect(report.exitCode).toBe(70)
    expect(renderSetup(report)).toContain('written config could not be loaded')
    expect(report.next).toBeUndefined()
    expect((await stat(context.configPath)).isFile()).toBe(true)
  })

  it('syncs a complete exclusive temporary file before publication', async () => {
    const actual = await vi.importActual<typeof FsPromises>('node:fs/promises')
    let synced = false
    vi.mocked(open).mockImplementation(async (...args) => {
      const handle = await actual.open(...args)
      if (args[1] === 'wx') {
        expect(args[2]).toBe(0o600)
        const sync = handle.sync.bind(handle)
        vi.spyOn(handle, 'sync').mockImplementation(async () => {
          await nothingWritten()
          expect(JSON.parse(await readFile(String(args[0]), 'utf8'))).toMatchObject({ version: 1 })
          await sync()
          synced = true
        })
      }
      return handle
    })
    expect((await runSetup(context)).exitCode).toBe(0)
    expect(synced).toBe(true)
  })

  it('does not overwrite a config published by another setup during detection', async () => {
    await mkdir(dirname(context.configPath), { mode: 0o700 })
    await executable('pi', `printf '{}\\n' > '${context.configPath}'; echo 1.2.0`)
    const report = await runSetup(context)
    expect(report.exitCode).toBe(75)
    expect(renderSetup(report)).toContain(
      'a config appeared while setup was running; rerun phosphor setup to see it',
    )
    expect(await readFile(context.configPath, 'utf8')).toBe('{}\n')
    expect(await readdir(dirname(context.configPath))).toEqual(['config.json'])
  })

  it('fails clearly when hard-link publication fails, with no rename fallback or temporary file left', async () => {
    vi.mocked(link).mockRejectedValueOnce(new Error('filesystem does not support hard links'))
    const report = await runSetup(context)
    expect(report.exitCode).toBe(70)
    expect(renderSetup(report)).toContain(
      'could not write config: filesystem does not support hard links',
    )
    await nothingWritten()
    expect(await readdir(dirname(context.configPath))).toEqual([])
  })

  it('creates 0700 directory and 0600 file under a permissive umask, with no temporary file left', async () => {
    const umask = process.umask(0)
    try {
      expect((await runSetup(context)).exitCode).toBe(0)
    } finally {
      process.umask(umask)
    }
    expect((await stat(dirname(context.configPath))).mode & 0o777).toBe(0o700)
    expect((await stat(context.configPath)).mode & 0o777).toBe(0o600)
    expect((await readFile(context.configPath, 'utf8')).endsWith('\n')).toBe(true)
    expect(await readdir(dirname(context.configPath))).toEqual(['config.json'])
  })
  it.each([0o200, 0o177, 0o100, 0o400, 0o700])(
    'creates 0700 directories and a 0600 file under the restrictive umask %o, and restores it',
    async (mask) => {
      context.configPath = join(dir, 'xdg', 'phosphor-host', 'config.json')
      const umask = process.umask(mask)
      let after: number
      try {
        expect((await runSetup(context)).exitCode).toBe(0)
      } finally {
        after = process.umask(umask)
      }
      expect(after).toBe(mask)
      for (const folder of [join(dir, 'xdg'), dirname(context.configPath)]) {
        expect((await stat(folder)).mode & 0o777).toBe(0o700)
      }
      expect((await stat(context.configPath)).mode & 0o777).toBe(0o600)
    },
  )
  it('writes a 0600 file into an existing 0700 directory under umask 200', async () => {
    await mkdir(dirname(context.configPath), { mode: 0o700 })
    const umask = process.umask(0o200)
    try {
      expect((await runSetup(context)).exitCode).toBe(0)
    } finally {
      process.umask(umask)
    }
    expect((await stat(context.configPath)).mode & 0o777).toBe(0o600)
  })
  it('does not repair an existing group-writable parent of a new directory', async () => {
    await mkdir(join(dir, 'shared'))
    await chmod(join(dir, 'shared'), 0o770)
    context.configPath = join(dir, 'shared', 'phosphor-host', 'config.json')
    expect((await runSetup(context)).exitCode).toBe(0)
    expect((await stat(join(dir, 'shared'))).mode & 0o777).toBe(0o770)
    expect((await stat(dirname(context.configPath))).mode & 0o777).toBe(0o700)
  })
  it('refuses, never chmods, a symlink swapped in after setup creates a directory', async () => {
    const target = join(dir, 'victim')
    await mkdir(target)
    await chmod(target, 0o755)
    const real = await vi.importActual<typeof FsPromises>('node:fs/promises')
    vi.mocked(mkdir).mockImplementationOnce(async (path) => {
      await real.mkdir(path, { mode: 0o700 })
      await real.rename(path, `${String(path)}-moved`)
      await real.symlink(target, path)
      return undefined
    })
    const report = await runSetup(context)
    expect(report.exitCode).toBe(78)
    expect(renderSetup(report)).toContain('changed while setup was creating it')
    expect((await stat(target)).mode & 0o777).toBe(0o755)
    expect(await readdir(target)).toEqual([])
  })
  it('sets the mode on the directory it opened, not on a symlink swapped in afterwards', async () => {
    const target = join(dir, 'victim')
    await mkdir(target)
    await chmod(target, 0o755)
    const real = await vi.importActual<typeof FsPromises>('node:fs/promises')
    const created = dirname(context.configPath)
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await real.open(path, flags, mode)
      if (path === created) {
        await real.rename(created, `${created}-moved`)
        await real.symlink(target, created)
      }
      return handle
    })
    await runSetup(context)
    expect((await stat(target)).mode & 0o777).toBe(0o755)
    expect((await stat(`${created}-moved`)).mode & 0o777).toBe(0o700)
  })
  it('refuses a directory it created that does not belong to the caller', async () => {
    context.uid = (context.uid ?? 0) + 1
    const report = await runSetup(context)
    expect(report.exitCode).toBe(78)
    expect(renderSetup(report)).toContain('changed while setup was creating it')
    await nothingWritten()
  })
  it('judges, never chmods, a directory that appears while setup creates it', async () => {
    const target = dirname(context.configPath)
    const real = await vi.importActual<typeof FsPromises>('node:fs/promises')
    vi.mocked(mkdir).mockImplementationOnce(async (path) => {
      await real.mkdir(path, { mode: 0o700 })
      await real.chmod(path, 0o770)
      throw Object.assign(new Error('exists'), { code: 'EEXIST' })
    })
    const report = await runSetup(context)
    expect(report.exitCode).toBe(78)
    expect(renderSetup(report)).toContain(`run chmod go-w ${target}`)
    expect((await stat(target)).mode & 0o777).toBe(0o770)
    await nothingWritten()
  })
  it('refuses an existing group-writable directory and prints the exact chmod', async () => {
    await mkdir(dirname(context.configPath))
    await chmod(dirname(context.configPath), 0o770)
    const report = await runSetup(context)
    expect(report.exitCode).toBe(78)
    expect(renderSetup(report)).toContain(`run chmod go-w ${dirname(context.configPath)}`)
    await nothingWritten()
  })
  it('refuses a directory owned by another uid', async () => {
    context.uid = (context.uid ?? 0) + 1
    expect((await runSetup(context)).exitCode).toBe(78)
    await nothingWritten()
  })
})

describe('setup Tailscale hint', () => {
  it.each(['ours', 'absent', 'other', 'funnel', 'unknown', 'missing', 'stopped'] as const)(
    'only suggests enable for an absent running route: %s',
    async (state) => {
      await oldConfig()
      const name = 'bee.tail123.ts.net'
      const serve =
        state === 'ours'
          ? JSON.stringify({
              TCP: { 47615: { HTTPS: true } },
              Web: {
                [`${name}:47615`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:47615' } } },
              },
            })
          : state === 'absent'
            ? '{}'
            : state === 'other'
              ? '{"TCP":{"47615":{"HTTP":true}}}'
              : state === 'funnel'
                ? JSON.stringify({ AllowFunnel: { [`${name}:47615`]: true } })
                : 'bad'
      const probe = vi.fn(async (_file: string, args: readonly string[]) => ({
        code: 0,
        signal: null,
        stdout:
          args[0] === 'status'
            ? JSON.stringify({
                BackendState: state === 'stopped' ? 'Stopped' : 'Running',
                Self: { DNSName: `${name}.` },
                CertDomains: [name],
              })
            : serve,
        stderr: 'private',
        timedOut: false,
        truncated: false,
      }))
      context.tailscale = {
        which: async () => (state === 'missing' ? null : '/fake/tailscale'),
        probe,
      }
      const report = await runSetup(context)
      expect(report.exitCode).toBe(0)
      expect(renderSetup(report).includes('Run phosphor setup.')).toBe(state === 'absent')
      expect(probe.mock.calls.every((call) => call[1].includes('status'))).toBe(true)
      expect(renderSetup(report)).not.toContain(name)
    },
  )
})

it('preserves api.port on replace and names it in the Tailscale hint', async () => {
  await oldConfig({ api: { port: 50001 } })
  context.replace = true
  const probe = vi.fn(async (_file: string, args: readonly string[]) => ({
    code: 0,
    signal: null,
    stdout:
      args[0] === 'status'
        ? '{"BackendState":"Running","Self":{"DNSName":"bee.tail123.ts.net."},"CertDomains":["bee.tail123.ts.net"]}'
        : '{}',
    stderr: '',
    timedOut: false,
    truncated: false,
  }))
  context.tailscale = { which: async () => '/fake/tailscale', probe }
  const report = await runSetup(context)
  expect(report.exitCode).toBe(0)
  expect((await saved()).api).toEqual({ port: 50001 })
  expect(renderSetup(report)).toContain('Port 50001: Run phosphor setup.')
  expect(probe.mock.calls.map((call) => call[1])).toEqual([
    ['status', '--json'],
    ['serve', 'status', '--json'],
  ])
})

it('never adds the cwd checkout to an existing config with no folders', async () => {
  await executable(
    'git',
    `if [ "$4" = --show-toplevel ]; then printf '%s\\n' '${repository}'; else exit 0; fi`,
  )
  await oldConfig({ repositories: [] })
  context.repositories = undefined
  const report = await runSetup(context)
  expect(report.exitCode).toBe(0)
  expect((await saved()).repositories).toEqual([])
})

it('redetects Claude and git without replace and preserves user PATH and repositories', async () => {
  const custom = join(dir, 'user-tools')
  await mkdir(custom)
  await oldConfig({
    environment: { path: [custom] },
    autoNameLanes: false,
    allowRepositoryChanges: false,
  })
  const first = await runSetup(context)
  expect(first.exitCode).toBe(0)
  const later = join(dir, 'later-tools')
  await executable('claude', 'echo 1.0.0', later)
  await executable('git', 'exit 1', later)
  context.env.PATH = `${later}:${bin}`
  context.repositories = []
  const refreshed = await runSetup(context)
  expect(refreshed.exitCode).toBe(0)
  expect(refreshed.changed).toBe(true)
  const config = await saved()
  expect(config.environment?.path).toEqual([custom, later])
  expect(config.repositories).toEqual([repository])
  expect(config.autoNameLanes).toBe(false)
  expect(config.allowRepositoryChanges).toBe(false)
  expect((await runSetup(context)).changed).toBe(false)
})

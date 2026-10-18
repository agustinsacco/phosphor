import { spawn } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', { spy: true })
vi.mock('node:fs/promises', { spy: true })
vi.mock('../config/load', { spy: true })
vi.mock('../machine/executables', { spy: true })
vi.mock('../machine/probe', { spy: true })
import { CONFIG_MAX_BYTES, loadHostConfig } from '../config/load'
import { validateHostConfig, type HostConfigV1 } from '../config/schema'
import { which } from '../machine/executables'
import { probe } from '../machine/probe'
import { runSetup, type SetupContext } from './setup'

let tempDir: string
let dir: string
let context: SetupContext
let repository: string
const pass = Array.from(
  { length: 64 },
  (_, index) => `V${String(index).padStart(3, '0')}${'x'.repeat(124)}`,
)

async function setup(tempPath: 'native' | 'long'): Promise<void> {
  tempDir = await realpath(await mkdtemp(join(tmpdir(), 'phosphor-setup-size-')))
  // Exercise a long macOS-style temp prefix even on Linux.
  dir = tempPath === 'long' ? join(tempDir, 'long-temp-prefix-'.repeat(8)) : tempDir
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const bin = join(dir, 'bin')
  repository = join(dir, 'project')
  const home = join(dir, 'home')
  await Promise.all([bin, repository, home].map((path) => mkdir(path, { mode: 0o700 })))
  const pi = join(bin, 'pi')
  await writeFile(pi, '#!/bin/sh\necho 1.2.0\n', { mode: 0o700 })
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
    replace: true,
    tailscaleHints: false,
  }
  // Detection has its own real-program suite. Keep filesystem validation and
  // persistence real here, but never launch 64 sequential git probes per run.
  vi.mocked(which).mockImplementation(async (name) =>
    name === 'pi' || name === 'git' ? join(bin, name) : null,
  )
  vi.mocked(probe).mockImplementation(async (_file, args) => ({
    code: args.includes('--version') ? 0 : 1,
    signal: null,
    stdout: args.includes('--version') ? '1.2.0\n' : '',
    stderr: '',
    timedOut: false,
    truncated: false,
  }))
}

afterEach(async () => {
  vi.resetAllMocks()
  vi.restoreAllMocks()
  await rm(tempDir, { recursive: true, force: true })
})

async function repositories(): Promise<string[]> {
  // Keep the candidate size stable without assuming /tmp's spelling or
  // exceeding the filesystem's per-component name limit.
  const segmentLength = Math.floor((800 - dir.length - 4) / 4)
  expect(segmentLength).toBeGreaterThan(0)
  expect(segmentLength).toBeLessThanOrEqual(255)
  const nested = join(dir, ...Array.from({ length: 4 }, () => 'd'.repeat(segmentLength)))
  await mkdir(nested, { recursive: true, mode: 0o700 })
  const paths = Array.from({ length: 64 }, (_, index) =>
    join(nested, `repo-${index}-${'r'.repeat(24)}`),
  )
  await Promise.all(paths.map((path) => mkdir(path, { mode: 0o700 })))
  return paths
}

async function oldConfig(resourceRoot: string): Promise<void> {
  const config: HostConfigV1 = {
    version: 1,
    pi: { executable: join(dir, 'bin', 'pi') },
    repositories: [repository],
    resourceRoot,
    environment: { pass },
  }
  expect(validateHostConfig(config).ok).toBe(true)
  await mkdir(dirname(context.configPath), { mode: 0o700, recursive: true })
  await writeFile(context.configPath, JSON.stringify(config), { mode: 0o600 })
}

async function published(): Promise<string> {
  const beforeLoads = vi.mocked(loadHostConfig).mock.calls.length
  const beforeOpens = vi.mocked(open).mock.calls.length
  const beforeRenames = vi.mocked(rename).mock.calls.length
  expect(await runSetup(context)).toMatchObject({ exitCode: 0, changed: true })
  // Both the old-file load and post-publication load use the real loader.
  expect(vi.mocked(loadHostConfig).mock.calls.slice(beforeLoads)).toEqual([
    [context.configPath, context.uid],
    [context.configPath, context.uid],
  ])
  expect(
    vi
      .mocked(open)
      .mock.calls.slice(beforeOpens)
      .filter(([, flags]) => flags === 'wx'),
  ).toEqual([[expect.stringMatching(/\.config-.*\.tmp$/), 'wx', 0o600]])
  expect(rename).toHaveBeenCalledTimes(beforeRenames + 1)
  expect(rename).toHaveBeenLastCalledWith(
    expect.stringMatching(/\.config-.*\.tmp$/),
    context.configPath,
  )
  expect(await readdir(dirname(context.configPath))).toEqual(['config.json'])
  const loaded = await loadHostConfig(context.configPath, context.uid)
  expect(loaded.ok).toBe(true)
  if (!loaded.ok) throw new Error('config did not load')
  expect(validateHostConfig(loaded.config).ok).toBe(true)
  expect(loaded.config.repositories).toEqual(context.repositories)
  return readFile(context.configPath, 'utf8')
}

describe.each(['native', 'long'] as const)(
  'setup config byte boundary (%s temp path)',
  (tempPath) => {
    beforeEach(async () => setup(tempPath))

    it('writes exactly 64 KiB, but refuses one byte more without replacing the old file', async () => {
      context.repositories = await repositories()
      await oldConfig('/r')
      const initial = await published()
      const remaining = CONFIG_MAX_BYTES - Buffer.byteLength(initial)
      expect(remaining).toBeGreaterThan(0)
      expect(remaining).toBeLessThan(4094)
      // Non-ASCII padding distinguishes UTF-8 bytes from JS string length.
      const resourceRoot = `/r${'é'.repeat(Math.floor(remaining / 2))}${'r'.repeat(remaining % 2)}`
      await oldConfig(resourceRoot)
      const exact = await published()
      expect(Buffer.byteLength(exact)).toBe(65536)
      expect(exact.length).toBeLessThan(65536)
      expect((await stat(context.configPath)).size).toBe(CONFIG_MAX_BYTES)
      expect(exact.endsWith('\n')).toBe(true)

      await oldConfig(`${resourceRoot}r`)
      const before = await readFile(context.configPath)
      const mtime = (await stat(context.configPath)).mtimeMs
      const writes = vi.mocked(rename).mock.calls.length
      const opens = vi.mocked(open).mock.calls.length
      expect(Buffer.byteLength(exact.replace(resourceRoot, `${resourceRoot}r`))).toBe(65537)
      expect(await runSetup(context)).toMatchObject({
        exitCode: 78,
        notes: expect.arrayContaining(['config is larger than 64 KiB']),
      })
      expect(await readFile(context.configPath)).toEqual(before)
      expect((await stat(context.configPath)).mtimeMs).toBe(mtime)
      expect(rename).toHaveBeenCalledTimes(writes)
      expect(
        vi
          .mocked(open)
          .mock.calls.slice(opens)
          .filter(([, flags]) => flags === 'wx'),
      ).toEqual([])
      expect(await readdir(dirname(context.configPath))).toEqual(['config.json'])
      expect(probe).toHaveBeenCalledTimes(195)
      expect(
        vi.mocked(probe).mock.calls.filter(([, args]) => args.includes('--git-dir')),
      ).toHaveLength(192)
      expect(spawn).not.toHaveBeenCalled()
    })
  },
)

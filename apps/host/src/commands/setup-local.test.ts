import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HOST_SIDECARS } from '@phosphor/shared/host-local'
import { loadHostConfig } from '../config/load'
import { runCli } from '../cli'
import { HOST_VERSION } from '../version'
import { runLocalSetup, type LocalSetupContext } from './setup-local'

let root: string, state: string, config: string, ctx: LocalSetupContext
const runner = vi.fn(async (_file: string, args: readonly string[]) => ({
  code: args.includes('is-active') ? 3 : 0,
  stdout: '',
}))
const portAvailable = vi.fn(async (port: number) => port === 47617)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'local-service-'))
  config = join(root, 'config', 'phosphor-host', 'config.json')
  state = join(root, 'state', 'phosphor-host')
  await mkdir(state, { recursive: true, mode: 0o700 })
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'pi'), '#!/bin/sh\necho 1.2.3\n', { mode: 0o700 })
  await writeFile(join(bin, 'git'), `#!/bin/sh\necho '${bin}'\n`, { mode: 0o700 })
  runner.mockClear()
  portAvailable.mockClear()
  ctx = {
    home: root,
    cwd: root,
    uid: process.getuid?.(),
    platform: 'linux',
    hostname: 'temp',
    nodeVersion: process.versions.node,
    defaultResourceRoot: root,
    env: {
      HOME: root,
      PATH: bin,
      XDG_STATE_HOME: dirname(state),
      XDG_CONFIG_HOME: join(root, 'config'),
    },
    configPath: config,
    pi: join(bin, 'pi'),
    owner: {
      id: randomUUID(),
      label: 'Mac',
      publicKey: Buffer.alloc(32, 42).toString('base64url'),
    },
    portAvailable,
    print: () => {},
    service: {
      runner,
      localLabel: 'test-local.service',
      node: join(bin, 'node'),
      bundle: join(bin, 'bundle'),
      user: 'test',
    },
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('pairs, publishes standby before starting, and preserves both foreign files and an existing config byte-for-byte', async () => {
  const foreign = join(state, 'foreign.plist')
  await writeFile(foreign, 'not ours')
  const before = await lstat(state)
  const result = await runLocalSetup({ ...ctx, standby: true })
  expect(result.exitCode, result.notes.join('\n')).toBe(0)
  expect(result.publicKey).toMatch(/^[\w-]{43}$/)
  expect(
    await lstat(join(dirname(config), HOST_SIDECARS.localKey)).then((s) => s.mode & 0o777),
  ).toBe(0o600)
  expect(await loadHostConfig(config, ctx.uid)).toMatchObject({
    ok: true,
    config: {
      repositories: [],
      pi: { executable: ctx.pi },
      api: { port: 47617 },
      environment: { pass: ['SSH_AUTH_SOCK'] },
    },
  })
  expect(portAvailable.mock.calls.flat()).toEqual([47615, 47616, 47617])
  expect(await readFile(join(state, HOST_SIDECARS.standby), 'utf8')).toContain('"version":1')
  expect(await lstat(state)).toMatchObject({ ino: before.ino, mode: before.mode })
  expect(await readFile(foreign, 'utf8')).toBe('not ours')
  expect(runner.mock.calls.flat(2)).not.toContain('enable-linger')
  const bytes = (await readFile(config, 'utf8')) + '\n'
  await writeFile(config, bytes)
  const unit = await readFile(join(root, 'config/systemd/user/test-local.service'), 'utf8')
  expect(unit).toContain(`XDG_STATE_HOME=${dirname(state)}`)
  portAvailable.mockClear()
  runner.mockClear()
  const output: string[] = []
  expect(
    await runCli(
      [
        'setup',
        '--local',
        '--owner-id',
        ctx.owner.id,
        '--owner-key',
        ctx.owner.publicKey,
        '--owner-label',
        'Mac',
        '--json',
        '--linger',
      ],
      { stdout: (line) => output.push(line), stderr: () => {} },
      { ...ctx, terminal: true },
    ),
  ).toBe(0)
  expect(JSON.parse(output.join(''))).toMatchObject({
    machineId: result.machineId,
    publicKey: result.publicKey,
  })
  expect(runner.mock.calls.flat(2)).toContain('enable-linger')
  expect(portAvailable).not.toHaveBeenCalled()
  expect(await readFile(config, 'utf8')).toBe(bytes)
})
it.each(['public', 'symlink', 'foreign uid'] as const)(
  'refuses a %s state folder before creating any config or unit',
  async (kind) => {
    if (kind === 'public') await chmod(state, 0o755)
    if (kind === 'symlink') {
      await rm(state, { recursive: true })
      await symlink(root, state)
    }
    if (kind === 'foreign uid') ctx.uid = (ctx.uid ?? 0) + 1
    const before = await lstat(state)
    expect(await runLocalSetup(ctx)).toMatchObject({ exitCode: 78 })
    expect(await lstat(state)).toMatchObject({ ino: before.ino, mode: before.mode })
    await expect(lstat(dirname(config))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(runner).not.toHaveBeenCalled()
  },
)
it('will not reconfigure or restart an active service', async () => {
  await writeFile(
    join(state, 'run.json'),
    JSON.stringify({ pid: 42, startedAt: 1, acceptedAt: 2, version: HOST_VERSION }),
  )
  const active = vi.fn(async () => ({ code: 0, stdout: '42' }))
  expect(
    await runLocalSetup({ ...ctx, service: { ...ctx.service, runner: active } }),
  ).toMatchObject({ exitCode: 0 })
  expect(active.mock.calls).toHaveLength(2)
  await expect(lstat(join(root, 'config/systemd'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('does not generate a replacement key when pairing metadata is inconsistent', async () => {
  expect((await runLocalSetup(ctx)).exitCode).toBe(0)
  await rm(join(dirname(config), HOST_SIDECARS.localKey))
  runner.mockClear()
  expect(await runLocalSetup(ctx)).toMatchObject({ exitCode: 78 })
  expect(runner).not.toHaveBeenCalled()
  await expect(lstat(join(dirname(config), HOST_SIDECARS.localKey))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

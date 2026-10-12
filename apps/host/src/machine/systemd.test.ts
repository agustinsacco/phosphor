import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { serviceUnit, writeServiceUnit, removeServiceUnit, serviceRunner } from './systemd'

describe('systemd unit', () => {
  it('renders the exact plain unit, captures only PATH and prevents permanent failures from restarting', () => {
    expect(
      serviceUnit('/bin/node', '/opt/phosphor.mjs', '/home/u/config.json', '/usr/bin:/bin'),
    ).toBe(
      '[Unit]\nDescription=Phosphor Host\n\n[Service]\nType=simple\nExecStart="/bin/node" "/opt/phosphor.mjs" "run" "--config" "/home/u/config.json"\nEnvironment="PATH=/usr/bin:/bin"\nRestart=on-failure\nRestartSec=10\nRestartPreventExitStatus=64 69 77 78\n\n[Install]\nWantedBy=default.target\n',
    )
  })
  it.each([
    ['/a b', '"/a b"'],
    ['/a%b', '"/a%%b"'],
    ['/a"b', '"/a\\"b"'],
    ['/a\\b', '"/a\\\\b"'],
  ])('quotes the exact path %s', (path, expected) => {
    const unit = serviceUnit(path, path, path, '/bin')
    expect(unit.split('\n').find((line) => line.startsWith('ExecStart='))).toBe(
      `ExecStart=${expected} ${expected} "run" "--config" ${expected}`,
    )
  })
  it('escapes dollar signs in arguments but refuses a dollar sign in the executable', () => {
    const unit = serviceUnit('/node', '/a$b', '/c$d', '/e$f')
    expect(unit.split('\n').find((line) => line.startsWith('ExecStart='))).toBe(
      'ExecStart="/node" "/a$$b" "run" "--config" "/c$$d"',
    )
    expect(unit).toContain('Environment="PATH=/e$f"')
    expect(unit).not.toContain('ExecStart=:')
    expect(() => serviceUnit('/a$b', '/bundle', '/config', '/bin')).toThrow(
      "the node path contains '$', which systemd cannot run safely; install Node elsewhere",
    )
  })
  it.each(['relative', '/a\nb', '/a\rb', '/a\u0000b', '/a\u007fb'])(
    'refuses unsafe paths %j',
    (path) => {
      expect(() => serviceUnit(path, '/bundle', '/config', '/bin')).toThrow()
    },
  )
  it('refuses unsafe or oversized PATH and supports exactly the cap', () => {
    expect(() => serviceUnit('/node', '/bundle', '/config', '\n')).toThrow()
    expect(() => serviceUnit('/node', '/bundle', '/config', 'a'.repeat(65536))).not.toThrow()
    expect(() => serviceUnit('/node', '/bundle', '/config', 'a'.repeat(65537))).toThrow()
  })
  it('supports the path cap and refuses one character beyond it in every position', () => {
    const path = '/' + 'a'.repeat(65535)
    for (const args of [
      [path, '/bundle', '/config'],
      ['/node', path, '/config'],
      ['/node', '/bundle', path],
    ]) {
      const [node, bundle, config] = args
      if (node === undefined || bundle === undefined || config === undefined)
        throw new Error('fixture')
      expect(() => serviceUnit(node, bundle, config, '')).not.toThrow()
      expect(() =>
        serviceUnit(
          node === path ? node + 'a' : node,
          bundle === path ? bundle + 'a' : bundle,
          config === path ? config + 'a' : config,
          '',
        ),
      ).toThrow()
    }
  })
  it('runs argv without a shell and closes stdin for probes and streamed output', async () => {
    const streamed: string[] = []
    const runner = serviceRunner({}, (text) => streamed.push(text))
    const script =
      'process.stdin.resume(); process.stdin.on("end", () => console.log(process.argv[1]))'
    const argument = 'literal;$(no-command)'
    expect(await runner(process.execPath, ['-e', script, argument])).toEqual({
      code: 0,
      stdout: argument + '\n',
    })
    expect(await runner(process.execPath, ['-e', script, argument], true)).toEqual({
      code: 0,
      stdout: '',
    })
    expect(streamed.join('')).toBe(argument + '\n')
  })
  it('refuses truncated probe results and stops a streaming child on cancellation', async () => {
    const streamed: string[] = []
    const abort = new AbortController()
    const runner = serviceRunner({}, (text) => streamed.push(text), abort.signal)
    const oversized = await runner(process.execPath, [
      '-e',
      'process.stdout.write("a".repeat(65537))',
    ])
    expect(oversized.code).toBeNull()
    expect(oversized.stdout).toHaveLength(65536)
    const following = runner(
      process.execPath,
      ['-e', 'console.log("started");setInterval(() => {}, 1000)'],
      true,
    )
    await vi.waitFor(() => expect(streamed.join('')).toContain('started'))
    abort.abort()
    expect((await following).code).toBeNull()
  })
  it('atomically replaces the unit with 0644 and removes only the unit, idempotently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-unit-'))
    try {
      const path = join(root, 'systemd', 'user', 'phosphor-host.service')
      await writeServiceUnit(path, 'old')
      await chmod(path, 0o600)
      await writeServiceUnit(path, 'new')
      expect(await readFile(path, 'utf8')).toBe('new')
      expect((await stat(path)).mode & 0o777).toBe(0o644)
      await removeServiceUnit(path)
      await removeServiceUnit(path)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

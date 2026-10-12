import { chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { serviceUnit, writeServiceUnit, removeServiceUnit } from './systemd'

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
    ['/a$b', '"/a$$b"'],
    ['/a"b', '"/a\\"b"'],
    ['/a\\b', '"/a\\\\b"'],
  ])('quotes the exact path %s', (path, expected) => {
    const unit = serviceUnit(path, path, path, '/bin')
    expect(unit.split('\n').find((line) => line.startsWith('ExecStart='))).toBe(
      `ExecStart=${expected} ${expected} "run" "--config" ${expected}`,
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

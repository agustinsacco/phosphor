import type * as Fs from 'node:fs'
import type * as Archive from '../update/archive'
import type * as RemoteHost from '@phosphor/shared/remote-host'
import {
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fixture, tar, bundle } from '../update/__fixtures__/release'
import { runUpdate, compareVersions } from './update'
import { atomicRecord } from '../update/files'
import { acquireInstallLock } from '../update/lock'
import type { Drainable } from '../shutdown'

const hooks = vi.hoisted(() => ({
  rename: undefined as ((from: string, to: string) => void) | undefined,
  read: undefined as ((url: unknown) => void) | undefined,
  rmdir: undefined as ((path: string) => void) | undefined,
  protocol: 1,
  decompressed: 0,
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof Fs>()
  return {
    ...fs,
    createReadStream: (...args: Parameters<typeof fs.createReadStream>) => {
      hooks.read?.(args[0])
      return fs.createReadStream(...args)
    },
    renameSync: (from: string, to: string) => {
      fs.renameSync(from, to)
      hooks.rename?.(from, to)
    },
    rmdirSync: (path: string) => {
      fs.rmdirSync(path)
      hooks.rmdir?.(path)
    },
  }
})
vi.mock('@phosphor/shared/remote-host', async (original) => ({
  ...(await original<typeof RemoteHost>()),
  get HOST_PROTOCOL_VERSION() {
    return hooks.protocol
  },
}))
vi.mock('../update/archive', async (original) => {
  const archive = await original<typeof Archive>()
  return {
    ...archive,
    decompressRelease: (...args: Parameters<typeof archive.decompressRelease>) => {
      hooks.decompressed++
      return archive.decompressRelease(...args)
    },
  }
})
const fixtures: ReturnType<typeof fixture>[] = []
function setup() {
  const f = fixture()
  fixtures.push(f)
  f.release()
  return f
}
afterEach(() => {
  hooks.rename = undefined
  hooks.read = undefined
  hooks.rmdir = undefined
  hooks.protocol = 1
  hooks.decompressed = 0
  for (const f of fixtures.splice(0)) f.cleanup()
})
const unchanged = (f: ReturnType<typeof fixture>) => {
  expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
  expect(
    readdirSync(f.lib).filter((n) => n.startsWith('.staging-') || n.startsWith('.install-lock')),
  ).toEqual([])
}
describe('runUpdate', () => {
  it('checks a signed flat offline mirror without downloading its artifact, and selects/prunes without touching data', async () => {
    const f = setup()
    for (const version of ['0.7.0', '0.8.0', '0.9.0']) f.install(version)
    const data = join(f.home, '.config/phosphor-host')
    mkdirSync(data, { recursive: true })
    writeFileSync(join(data, 'marker'), 'keep')
    rmSync(join(f.assets, 'phosphor-host-1.2.3-linux-x64.tar.gz'))
    expect(await runUpdate(f.context, { check: true })).toBe(0)
    expect(f.messages).toContain('Installed: 1.0.0; available: 1.2.3')
    unchanged(f)
    f.release()
    expect(await runUpdate(f.context)).toBe(0)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
    expect(JSON.parse(readFileSync(join(f.lib, 'install.json'), 'utf8'))).toEqual({
      current: '1.2.3',
      previous: '1.0.0',
    })
    expect(readdirSync(join(f.lib, 'versions')).sort()).toEqual(['0.9.0', '1.0.0', '1.2.3'])
    expect(readFileSync(join(data, 'marker'), 'utf8')).toBe('keep')
    expect(f.messages).toContain('restart phosphor run to use 1.2.3')
    f.context.update = {
      ...f.context.update,
      node: join(f.lib, 'current/node/bin/node'),
      bundle: join(f.lib, 'current/lib/phosphor.mjs'),
    }
    f.release('1.2.3', bundle(), (m) => {
      m.protocols = [2]
    })
    expect(await runUpdate(f.context)).toBe(0)
    expect(f.messages).toContain('already up to date')
    expect(f.messages.some((m) => m.includes('newer Host protocol'))).toBe(false)
  })
  it('refuses a directory posing as the required program file before publication', async () => {
    const f = setup()
    const record = join(f.lib, 'install.json')
    atomicRecord(record, { current: '1.0.0', previous: '0.9.0' }, 0o644)
    const before = readFileSync(record, 'utf8')
    f.release(
      '1.2.3',
      gzipSync(
        tar([
          { name: 'VERSION', text: '1.2.3' },
          { name: 'bin/phosphor' },
          { name: 'node/bin/node' },
          { name: 'lib/phosphor.mjs/child' },
        ]),
      ),
    )
    expect(await runUpdate(f.context)).toBe(75)
    expect(f.messages).toContain('Invalid release bundle.')
    unchanged(f)
    expect(readFileSync(record, 'utf8')).toBe(before)
    expect(readdirSync(join(f.lib, 'versions'))).toEqual(['1.0.0'])
  })
  it('verifies the signed exact size and hash before decompressing', async () => {
    for (const kind of ['hash', 'size']) {
      const f = setup()
      f.release('1.2.3', bundle(), (m) => {
        const a = m.artifacts[0]
        if (a) {
          if (kind === 'hash') a.sha256 = '0'.repeat(64)
          else a.bytes++
        }
      })
      expect(await runUpdate(f.context)).toBe(75)
      expect(hooks.decompressed).toBe(0)
      unchanged(f)
    }
  })
  it('requires a release layout and pinned keys', async () => {
    const f = setup()
    expect(
      await runUpdate({ ...f.context, update: { ...f.context.update, node: process.execPath } }),
    ).toBe(69)
    expect(await runUpdate({ ...f.context, update: { ...f.context.update, keys: [] } })).toBe(69)
    unchanged(f)
  })
  it.each([
    [
      'unsigned',
      75,
      (f: ReturnType<typeof fixture>) => {
        rmSync(join(f.assets, 'phosphor-host.manifest.json.sig'))
      },
    ],
    [
      'tampered',
      75,
      (f: ReturnType<typeof fixture>) => {
        writeFileSync(join(f.assets, 'phosphor-host.manifest.json'), '{}')
      },
    ],
    [
      'downgrade',
      64,
      (f: ReturnType<typeof fixture>) => {
        f.release('0.9.0')
      },
    ],
    [
      'platform',
      69,
      (f: ReturnType<typeof fixture>) => {
        f.context.arch = 'arm64'
      },
    ],
    [
      'protocol',
      69,
      (f: ReturnType<typeof fixture>) => {
        f.release('1.2.3', bundle(), (m) => {
          m.protocols = [1]
        })
        hooks.protocol = 2
      },
    ],
    [
      'hash',
      75,
      (f: ReturnType<typeof fixture>) => {
        f.release('1.2.3', bundle(), (m) => {
          if (m.artifacts[0]) m.artifacts[0].sha256 = '0'.repeat(64)
        })
      },
    ],
    [
      'size short',
      75,
      (f: ReturnType<typeof fixture>) => {
        f.release('1.2.3', bundle(), (m) => {
          if (m.artifacts[0]) m.artifacts[0].bytes++
        })
      },
    ],
    [
      'size long',
      75,
      (f: ReturnType<typeof fixture>) => {
        f.release('1.2.3', bundle(), (m) => {
          if (m.artifacts[0]) m.artifacts[0].bytes--
        })
      },
    ],
    [
      'VERSION mismatch',
      75,
      (f: ReturnType<typeof fixture>) => {
        f.release('1.2.3', bundle('1.2.4'))
      },
    ],
    [
      'missing bundle',
      75,
      (f: ReturnType<typeof fixture>) => {
        f.release('1.2.3', gzipSync(tar([{ name: 'VERSION', text: '1.2.3' }])))
      },
    ],
    [
      'existing version',
      69,
      (f: ReturnType<typeof fixture>) => {
        f.install('1.2.3')
      },
    ],
    [
      'gzip bomb',
      75,
      (f: ReturnType<typeof fixture>) => {
        const expanded = tar([
          { name: 'VERSION', text: '1.2.3' },
          { name: 'bin/phosphor' },
          { name: 'node/bin/node' },
          { name: 'lib/phosphor.mjs' },
          { name: 'lib/bomb', text: 'x'.repeat(8192) },
        ])
        f.context.update = { ...f.context.update, expandedCap: expanded.length - 1 }
        f.release('1.2.3', gzipSync(expanded))
      },
    ],
  ])('refuses %s without changing current or leaving staging', async (_name, code, prepare) => {
    const f = setup()
    prepare(f)
    expect(await runUpdate(f.context)).toBe(code)
    unchanged(f)
  })
  it.each(['1.2.3 ', '1.2.3\r'])(
    'refuses VERSION with non-newline trailing whitespace %j',
    async (version) => {
      const f = setup()
      f.release('1.2.3', bundle(version))
      expect(await runUpdate(f.context)).toBe(75)
      unchanged(f)
    },
  )
  it('checks pinned signed version and strict requested versions', async () => {
    const f = setup()
    f.release('1.2.3', bundle(), undefined, '1.2.4')
    expect(await runUpdate(f.context, { version: '1.2.4' })).toBe(64)
    expect(await runUpdate(f.context, { version: '01.2.3' })).toBe(64)
    expect(await runUpdate(f.context, { rollback: true, check: true })).toBe(64)
    unchanged(f)
  })
  it.each(['../escape', '/absolute', 'lib/../escape', 'lib/./escape'])(
    'refuses hostile path %s',
    async (name) => {
      const f = setup()
      f.release(
        '1.2.3',
        gzipSync(
          tar([
            { name: 'VERSION', text: '1.2.3' },
            { name: 'bin/phosphor' },
            { name: 'node/bin/node' },
            { name: 'lib/phosphor.mjs' },
            { name },
          ]),
        ),
      )
      expect(await runUpdate(f.context)).toBe(75)
      unchanged(f)
    },
  )
  it.each(['1', '2', '3', '4', '5', '6', 'x'])(
    'refuses link, device or unsupported entry type %s',
    async (type) => {
      const f = setup()
      f.release(
        '1.2.3',
        gzipSync(
          tar([
            { name: 'VERSION', text: '1.2.3' },
            { name: 'bin/phosphor' },
            { name: 'node/bin/node' },
            { name: 'lib/phosphor.mjs' },
            { name: 'lib/evil', type },
          ]),
        ),
      )
      expect(await runUpdate(f.context)).toBe(75)
      unchanged(f)
    },
  )
  it.each(['checksum', 'truncated', 'entries', 'declared size', 'trailing garbage', 'duplicate'])(
    'cleans staging for corrupt archive %s',
    async (kind) => {
      const f = setup()
      let expanded = tar([
        { name: 'VERSION', text: '1.2.3' },
        { name: 'bin/phosphor' },
        { name: 'node/bin/node' },
        { name: 'lib/phosphor.mjs' },
      ])
      if (kind === 'checksum') expanded[108] = 49
      if (kind === 'truncated') expanded = expanded.subarray(0, -512)
      if (kind === 'entries')
        expanded = tar(Array.from({ length: 4097 }, (_, i) => ({ name: `lib/file${i}`, text: '' })))
      if (kind === 'declared size') expanded = tar([{ name: 'lib/a', size: 999999 }])
      if (kind === 'trailing garbage') expanded[expanded.length - 1] = 1
      if (kind === 'duplicate') expanded = tar([{ name: 'lib/a' }, { name: 'lib/a' }])
      f.release('1.2.3', gzipSync(expanded))
      expect(await runUpdate(f.context)).toBe(75)
      unchanged(f)
    },
  )
  it('restarts active Linux and loaded macOS services and accepts only a fresh new-version heartbeat', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const f = setup()
      if (platform === 'darwin') {
        f.context.platform = platform
        f.context.arch = 'arm64'
        // Re-sign using the matching platform through the fixture's manifest mutation.
        f.release('1.2.3', bundle(), (m) => {
          if (m.artifacts[0]) {
            m.artifacts[0].target = 'darwin-arm64'
            m.artifacts[0].file = 'phosphor-host-1.2.3-darwin-arm64.tar.gz'
          }
        })
        writeFileSync(join(f.assets, 'phosphor-host-1.2.3-darwin-arm64.tar.gz'), bundle())
      } else {
        const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
        mkdirSync(join(unit, '..'), { recursive: true })
        writeFileSync(unit, 'unit')
      }
      const calls: string[][] = []
      let now = 10000
      f.context.now = () => now
      f.context.wait = async () => {
        now += 1000
      }
      f.context.service = {
        runner: async (_p, args) => {
          calls.push([...args])
          if (args.includes('restart') || args.includes('kickstart')) {
            const state = join(f.home, '.local/state/phosphor-host')
            mkdirSync(state, { recursive: true })
            atomicRecord(
              join(state, 'run.json'),
              { version: '1.2.3', pid: process.pid, startedAt: now, acceptedAt: now },
              0o600,
            )
          }
          return { code: 0, stdout: '', stderr: '' }
        },
      }
      expect(await runUpdate(f.context)).toBe(0)
      expect(calls.some((args) => args.includes('restart') || args.includes('kickstart'))).toBe(
        true,
      )
      expect(f.messages).toEqual(['Phosphor Host service restarted.', 'Selected Host 1.2.3.'])
    }
  })
  it.each(['old version', 'old start', 'future', 'bad record', 'missing'])(
    'rolls back failed health: %s',
    async (kind) => {
      const f = setup()
      const unit = join(f.home, '.config/systemd/user/phosphor-host.service')
      mkdirSync(join(unit, '..'), { recursive: true })
      writeFileSync(unit, 'unit')
      const state = join(f.home, '.local/state/phosphor-host')
      mkdirSync(state, { recursive: true })
      const record = { version: '1.2.3', pid: process.pid, startedAt: 10000, acceptedAt: 10000 }
      if (kind === 'old version') record.version = '1.0.0'
      if (kind === 'old start') record.startedAt = 9999
      if (kind === 'future') record.acceptedAt = 999999
      if (kind !== 'missing')
        atomicRecord(join(state, 'run.json'), kind === 'bad record' ? {} : record, 0o600)
      f.context.now = () => 10000
      f.context.wait = async () => {}
      let restarts = 0
      f.context.service = {
        runner: async (_p, args) => {
          if (args.includes('restart')) restarts++
          return { code: 0, stdout: '', stderr: '' }
        },
      }
      expect(await runUpdate(f.context)).toBe(75)
      unchanged(f)
      expect(restarts).toBe(2)
      expect(f.messages).toContain('update to 1.2.3 failed its health check; rolled back to 1.0.0')
    },
  )
  it('rolls back offline and rejects missing, corrupt, linked or wrong metadata', async () => {
    const f = setup()
    f.install('0.9.0')
    rmSync(f.assets, { recursive: true })
    const record = join(f.lib, 'install.json')
    for (const value of [
      {},
      { current: '0.8.0', previous: '0.9.0' },
      { current: '1.0.0', previous: '../escape' },
      { current: '1.0.0', previous: '0.8.0' },
      { current: '1.0.0', previous: '1.0.0' },
    ]) {
      atomicRecord(record, value, 0o644)
      expect(await runUpdate(f.context, { rollback: true })).toBe(69)
      unchanged(f)
    }
    atomicRecord(record, { current: '1.0.0', previous: '0.9.0' }, 0o644)
    expect(await runUpdate(f.context, { rollback: true })).toBe(0)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/0.9.0')
    expect(f.messages.slice(-2)).toEqual([
      'restart phosphor run to use 0.9.0',
      'Selected Host 0.9.0.',
    ])
  })
  it.each(['folder', 'VERSION', 'executable', 'metadata'])(
    'refuses a linked rollback %s without reading a network asset',
    async (kind) => {
      const f = setup()
      const old = f.install('0.9.0')
      const record = join(f.lib, 'install.json')
      atomicRecord(record, { current: '1.0.0', previous: '0.9.0' }, 0o644)
      const target =
        kind === 'folder'
          ? old
          : kind === 'metadata'
            ? record
            : join(old, kind === 'VERSION' ? 'VERSION' : 'node/bin/node')
      renameSync(target, target + '.original')
      symlinkSync(target + '.original', target)
      rmSync(f.assets, { recursive: true })
      expect(await runUpdate(f.context, { rollback: true })).toBe(kind === 'metadata' ? 75 : 69)
      unchanged(f)
    },
  )
  it('accepts a newer protocol, verifies a matching pinned release and says apps must update', async () => {
    const f = setup()
    const release = (protocols: number[]) =>
      f.release(
        '1.2.3',
        bundle(),
        (m) => {
          m.protocols = protocols
        },
        '1.2.3',
      )
    const notice =
      'This release speaks a newer Host protocol: apps that have not updated cannot connect.'
    release([1, 2])
    expect(await runUpdate(f.context, { version: '1.2.3', check: true })).toBe(0)
    expect(f.messages).not.toContain(notice)
    release([2])
    expect(await runUpdate(f.context, { version: '1.2.3', check: true })).toBe(0)
    expect(f.messages.slice(-2)).toEqual(['Installed: 1.0.0; available: 1.2.3', notice])
    unchanged(f)
    release([2])
    expect(await runUpdate(f.context, { version: '1.2.3' })).toBe(0)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
    expect(f.messages.slice(-2)).toEqual(['Selected Host 1.2.3.', notice])
  })
  it('removes the published folder and restores current if the metadata write fails', async () => {
    const f = setup()
    mkdirSync(join(f.lib, 'install.json'))
    expect(await runUpdate(f.context)).toBe(75)
    unchanged(f)
    expect(readdirSync(join(f.lib, 'versions'))).toEqual(['1.0.0'])
  })
  it('defers a signal injected inside current swap until install.json is consistent', async () => {
    const f = setup()
    let target: Drainable | undefined
    f.context.attach = (t) => {
      target = t
      return () => {}
    }
    hooks.rename = (_from, to) => {
      if (to === join(f.lib, 'current')) void target?.drain('SIGINT')
    }
    expect(await runUpdate(f.context)).toBe(130)
    expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.2.3')
    expect(JSON.parse(readFileSync(join(f.lib, 'install.json'), 'utf8')).current).toBe('1.2.3')
    expect(
      readdirSync(f.lib).some((n) => n.startsWith('.install-lock') || n.startsWith('.staging')),
    ).toBe(false)
    expect(f.messages.some((m) => m.startsWith('Selected Host'))).toBe(false)
  })
  it.each(['check', 'up to date', 'update'] as const)(
    'claims no %s result after a signal that arrives as the lock is released',
    async (kind) => {
      const f = setup()
      if (kind === 'up to date') {
        expect(await runUpdate(f.context)).toBe(0)
        f.context.update = {
          ...f.context.update,
          node: join(f.lib, 'current/node/bin/node'),
          bundle: join(f.lib, 'current/lib/phosphor.mjs'),
        }
      }
      // A newer-only release, so the protocol notice would be printed too.
      f.release('1.2.3', bundle(), (m) => {
        m.protocols = [2]
      })
      let target: Drainable | undefined
      f.context.attach = (t) => {
        target = t
        return () => {}
      }
      hooks.rmdir = (path) => {
        // Release retires the lock by rename, then removes it.
        if (path.startsWith(join(f.lib, '.install-lock.retired.'))) void target?.drain('SIGINT')
      }
      const before = f.messages.length
      expect(await runUpdate(f.context, { check: kind === 'check' })).toBe(130)
      expect(f.messages.slice(before)).toEqual([])
      expect(readlinkSync(join(f.lib, 'current'))).toBe(
        kind === 'check' ? 'versions/1.0.0' : 'versions/1.2.3',
      )
      expect(readdirSync(f.lib).some((n) => /^\.(staging-|install-lock)/.test(n))).toBe(false)
    },
  )
  it('cleans staging and own lock after a signal during artifact download', async () => {
    const f = setup()
    let target: Drainable | undefined
    f.context.attach = (t) => {
      target = t
      return () => {}
    }
    hooks.read = (url) => {
      if (String(url).endsWith('.tar.gz')) void target?.drain('SIGTERM')
    }
    expect(await runUpdate(f.context)).toBe(143)
    unchanged(f)
  })
  it('refuses a concurrent installer for both update and offline rollback', async () => {
    const f = setup()
    const release = acquireInstallLock(f.lib)
    try {
      expect(await runUpdate(f.context)).toBe(75)
      expect(await runUpdate(f.context, { rollback: true })).toBe(75)
      expect(f.messages.every((m) => m.includes('.install-lock'))).toBe(true)
      expect(readlinkSync(join(f.lib, 'current'))).toBe('versions/1.0.0')
    } finally {
      release()
    }
    unchanged(f)
  })
  it('compares full numeric version components', () => {
    expect(compareVersions('1.10.0', '1.9.999')).toBeGreaterThan(0)
    expect(compareVersions('2.0.0', '1.999.999')).toBeGreaterThan(0)
    expect(compareVersions('1.2.0', '1.2.3')).toBeLessThan(0)
  })
})

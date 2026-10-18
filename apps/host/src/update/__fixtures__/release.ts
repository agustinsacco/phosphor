import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { UpdateContext } from '../../commands/update'
import type { HostReleaseManifest } from '@phosphor/shared/host-release'
import {
  createReleaseMirror,
  installCurrent,
  installVersion,
  publishRelease,
} from './release-files'

export interface Entry {
  name: string
  text?: string
  type?: string
  size?: number
}
export function tar(entries: Entry[], ending = Buffer.alloc(1024)): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.text ?? 'test')
    const h = Buffer.alloc(512)
    h.write(entry.name)
    h.write('0000755\0', 100)
    h.write('0000000\0', 108)
    h.write('0000000\0', 116)
    h.write((entry.size ?? data.length).toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136)
    h.fill(32, 148, 156)
    h.write(entry.type ?? '0', 156)
    h.write('ustar\0', 257)
    h.write('00', 263)
    h.write(
      h
        .reduce((n, b) => n + b, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    )
    parts.push(h, data, Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length))
  }
  return Buffer.concat([...parts, ending])
}
export function bundle(version = '1.2.3'): Buffer {
  return gzipSync(
    tar([
      { name: 'VERSION', text: version + '\n' },
      ...['bin/phosphor', 'node/bin/node', 'node/LICENSE', 'lib/phosphor.mjs'].map((name) => ({
        name,
      })),
    ]),
  )
}
export function fixture() {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'host-update-')))
  const lib = join(home, '.local/lib/phosphor-host')
  const mirror = createReleaseMirror(home)
  const { assets, keys } = mirror
  const messages: string[] = []
  const install = (version: string) => installVersion(lib, version)
  const old = installCurrent(home, lib)
  const context: UpdateContext = {
    home,
    nodeVersion: process.versions.node,
    defaultResourceRoot: '/unused',
    env: { PHOSPHOR_HOST_RELEASE_URL: pathToFileURL(assets).href },
    uid: process.getuid?.(),
    hostname: 'test-host',
    platform: 'linux',
    arch: 'x64',
    configPath: join(home, '.config/phosphor-host/config.json'),
    print: (line) => messages.push(line),
    update: { node: join(old, 'node/bin/node'), bundle: join(old, 'lib/phosphor.mjs'), keys },
    service: { runner: async () => ({ code: 3, stdout: '', stderr: '' }) },
  }
  const release = (
    version = '1.2.3',
    bytes = bundle(version),
    change: (m: HostReleaseManifest) => void = () => {},
    request?: string,
  ) => publishRelease(mirror, version, bytes, change, request)
  return {
    home,
    lib,
    old,
    assets,
    keys,
    messages,
    context,
    install,
    release,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}

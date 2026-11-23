import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { tar } from '@phosphor/session-runtime/host-install/__fixtures__/tar'
import type { UpdateContext } from '../../commands/update'
import type { HostReleaseManifest } from '@phosphor/shared/host-release'
import {
  createReleaseMirror,
  installCurrent,
  installVersion,
  publishRelease,
} from './release-files'

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

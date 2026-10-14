import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import type { UpdateContext } from '../../commands/update'
import type { HostReleaseManifest } from '@phosphor/shared/host-release'

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
  const assets = join(home, 'assets')
  mkdirSync(assets)
  const key = join(home, 'throwaway')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  const keys = [{ id: 'test', publicKey: readFileSync(key + '.pub', 'utf8').trim() }]
  const messages: string[] = []
  const install = (version: string) => {
    const folder = join(lib, 'versions', version)
    for (const name of ['VERSION', 'bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs']) {
      mkdirSync(join(folder, name, '..'), { recursive: true })
      writeFileSync(join(folder, name), name === 'VERSION' ? version + '\n' : 'test')
    }
    return folder
  }
  const old = install('1.0.0')
  symlinkSync('versions/1.0.0', join(lib, 'current'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  symlinkSync(join(lib, 'current/bin/phosphor'), join(home, '.local/bin/phosphor'))
  const context: UpdateContext = {
    home,
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
  ) => {
    const file = `phosphor-host-${version}-linux-x64.tar.gz`
    const manifest: HostReleaseManifest = {
      schema: 1,
      version,
      protocols: [1],
      node: '24.14.1',
      sourceCommit: 'a'.repeat(40),
      artifacts: [
        {
          target: 'linux-x64',
          file,
          bytes: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex'),
        },
      ],
    }
    change(manifest)
    const path = join(
      assets,
      request ? `phosphor-host-${request}.manifest.json` : 'phosphor-host.manifest.json',
    )
    writeFileSync(path, JSON.stringify(manifest) + '\n')
    rmSync(path + '.sig', { force: true })
    execFileSync('ssh-keygen', ['-Y', 'sign', '-f', key, '-n', 'phosphor-host-release', path], {
      stdio: 'pipe',
    })
    writeFileSync(join(assets, file), bytes)
    return path
  }
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

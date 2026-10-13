import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  lstatSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import process from 'node:process'
import { root, pin, sha256, contract, isEntryPoint } from './common.mjs'
import { archive } from './archive.mjs'
import { generateInstaller } from './installer.mjs'

export async function nodeArchive(target, cache, nodePin = pin) {
  const hash = nodePin.archives[target]
  if (!hash) throw new Error('Unsupported bundle target')
  const file = `node-v${nodePin.version}-${target}.tar.gz`
  mkdirSync(cache, { recursive: true })
  const path = join(cache, file)
  let bytes
  if (existsSync(path)) {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size > contract.HOST_RELEASE_ARTIFACT_MAX_BYTES)
      throw new Error('Invalid cached Node archive')
    bytes = readFileSync(path)
  } else {
    const response = await globalThis.fetch(`https://nodejs.org/dist/v${nodePin.version}/${file}`, {
      redirect: 'error',
      signal: globalThis.AbortSignal.timeout(120000),
    })
    if (!response.ok) throw new Error('Node download failed')
    const chunks = []
    let size = 0
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > contract.HOST_RELEASE_ARTIFACT_MAX_BYTES)
        throw new Error('Node download too large')
      chunks.push(Buffer.from(chunk))
    }
    bytes = Buffer.concat(chunks)
  }
  if (sha256(bytes) !== hash) throw new Error('Node archive hash mismatch')
  if (!existsSync(path)) writeFileSync(path, bytes, { flag: 'wx' })
  return bytes
}
export async function buildBundle(target, out, cache = join(out, '.node-cache'), nodePin = pin) {
  const version = process.env.HOST_RELEASE_VERSION
  if (!version || !contract.HOST_RELEASE_VERSION_PATTERN.test(version))
    throw new Error('Invalid HOST_RELEASE_VERSION')
  if (!contract.HOST_RELEASE_TARGETS.includes(target)) throw new Error('Unsupported bundle target')
  const node = await nodeArchive(target, cache, nodePin)
  const temp = mkdtempSync(join(tmpdir(), 'phosphor-bundle-'))
  try {
    const stage = join(temp, 'stage')
    mkdirSync(join(stage, 'bin'), { recursive: true })
    mkdirSync(join(stage, 'node/bin'), { recursive: true })
    execFileSync(process.execPath, ['apps/host/scripts/build.mjs', '--out', join(stage, 'lib')], {
      cwd: root,
      stdio: 'pipe',
    })
    const checkedArchive = join(temp, 'node.tar.gz')
    writeFileSync(checkedArchive, node)
    const prefix = `node-v${nodePin.version}-${target}`
    execFileSync(
      'tar',
      ['-xzf', checkedArchive, '-C', temp, `${prefix}/bin/node`, `${prefix}/LICENSE`],
      {
        stdio: 'pipe',
      },
    )
    cpSync(join(temp, prefix, 'bin/node'), join(stage, 'node/bin/node'))
    cpSync(join(temp, prefix, 'LICENSE'), join(stage, 'node/LICENSE'))
    writeFileSync(join(stage, 'VERSION'), `${version}\n`)
    writeFileSync(
      join(stage, 'bin/phosphor'),
      `#!/bin/sh\nset -eu\n# Follow relative or absolute symlinks without GNU readlink -f.\nself=$0\ni=0\nwhile [ -L "$self" ]; do\n  i=$((i + 1))\n  [ "$i" -le 40 ] || exit 1\n  dir=$(CDPATH= cd -P "$(dirname "$self")" && pwd)\n  link=$(readlink "$self")\n  case $link in /*) self=$link ;; *) self=$dir/$link ;; esac\ndone\nbase=$(CDPATH= cd -P "$(dirname "$self")/.." && pwd)\nexec "$base/node/bin/node" "$base/lib/phosphor.mjs" "$@"\n`,
    )
    mkdirSync(out, { recursive: true })
    const file = join(out, `phosphor-host-${version}-${target}.tar.gz`)
    writeFileSync(file, archive(stage))
    generateInstaller(join(out, 'install.sh'))
    return file
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
if (isEntryPoint(import.meta.url)) {
  const { values } = parseArgs({
    options: { target: { type: 'string' }, out: { type: 'string' }, cache: { type: 'string' } },
  })
  await buildBundle(
    values.target,
    resolve(values.out ?? '.'),
    values.cache && resolve(values.cache),
  )
}

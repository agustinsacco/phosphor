import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeArchive } from '../../../../tools/host-release/build-bundle.mjs'
import { buildNative } from '../../../../tools/host-release/build-native.mjs'

/** Build the same verified native resources as a release, never Desktop's
 * Electron-rebuilt addon. Model/auth traffic stays on the deterministic stubs;
 * build preparation may fetch the checksum-pinned Node runtime and node-gyp. */
export async function withHostNative(build) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'phosphor-e2e-native-')))
  try {
    const bytes = await nodeArchive(`${process.platform}-${process.arch}`, join(root, 'cache'))
    const archive = join(root, 'node.tar.gz')
    writeFileSync(archive, bytes, { flag: 'wx' })
    const runtime = join(root, 'runtime')
    mkdirSync(runtime)
    execFileSync('tar', ['-xzf', archive, '-C', runtime, '--strip-components=1'])
    const native = join(root, 'native')
    buildNative(native, join(runtime, 'bin/node'))
    // The dev Host uses the runner's Node (minimum 22), not the bundled one.
    execFileSync(process.execPath, [
      '-e',
      `require(${JSON.stringify(join(native, 'lib/index.js'))})`,
    ])
    return build(native)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

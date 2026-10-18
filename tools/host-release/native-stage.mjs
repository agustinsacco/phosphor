import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Copy node-pty from `source` into `temp` and select the addon for `target`:
 * node-pty's shipped prebuild, else a clean rebuild of the copy for Node
 * `nodeVersion`. `source` is never written. Returns the copy and the folder
 * holding the selected pty.node.
 */
export function prepareNativeSource({ source, temp, target, nodeVersion }) {
  const packageRoot = join(temp, 'node-pty')
  cpSync(source, packageRoot, { recursive: true })
  // Never use Desktop's Electron-rebuilt addon. Only node-pty's shipped prebuild or a clean rebuild.
  rmSync(join(packageRoot, 'build'), { recursive: true, force: true })
  const prebuild = join(packageRoot, 'prebuilds', target)
  if (!existsSync(join(prebuild, 'pty.node'))) {
    const addon = dirname(
      createRequire(join(source, 'package.json')).resolve('node-addon-api/package.json'),
    )
    mkdirSync(join(temp, 'node_modules'), { recursive: true })
    cpSync(addon, join(temp, 'node_modules/node-addon-api'), { recursive: true })
    execFileSync(
      'npm',
      [
        'exec',
        '--yes',
        '--package=node-gyp@11.4.2',
        '--',
        'node-gyp',
        'rebuild',
        `--target=${nodeVersion}`,
      ],
      { cwd: packageRoot, stdio: 'pipe' },
    )
  }
  const binary = existsSync(join(packageRoot, 'build/Release/pty.node'))
    ? join(packageRoot, 'build/Release')
    : prebuild
  return { packageRoot, binary }
}

/**
 * Write the native resource tree into `out`: node-pty's shipped lib JS, the
 * addon from `binary` (and its spawn-helper, made executable), LICENSE and the
 * TARGET.json marker that validateNative checks.
 */
export function stageNativeResources({
  packageRoot,
  binary,
  out,
  target,
  nodeVersion,
  ptyVersion,
}) {
  mkdirSync(join(out, 'build/Release'), { recursive: true })
  mkdirSync(join(out, 'lib'), { recursive: true })
  for (const name of readdirSync(join(packageRoot, 'lib')))
    if (name.endsWith('.js') && !name.endsWith('.test.js'))
      cpSync(join(packageRoot, 'lib', name), join(out, 'lib', name))
  cpSync(join(binary, 'pty.node'), join(out, 'build/Release/pty.node'))
  if (existsSync(join(binary, 'spawn-helper'))) {
    cpSync(join(binary, 'spawn-helper'), join(out, 'build/Release/spawn-helper'))
    chmodSync(join(out, 'build/Release/spawn-helper'), 0o755)
  }
  cpSync(join(packageRoot, 'LICENSE'), join(out, 'LICENSE'))
  writeFileSync(
    join(out, 'TARGET.json'),
    JSON.stringify({ target, node: nodeVersion, version: ptyVersion }) + '\n',
  )
}

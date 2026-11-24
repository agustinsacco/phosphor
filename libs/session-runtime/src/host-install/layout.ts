import { lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { HOST_RELEASE_BASE_URL } from './download'
import { HOST_RELEASE_VERSION_PATTERN } from '@phosphor/shared/host-release'

export interface InstalledLayout {
  lib: string
  version: string
  current: string
}
export function installedLayout(
  execPath: string,
  bundlePath: string,
  home: string,
): InstalledLayout | null {
  try {
    const lib = join(realpathSync(home), '.local/lib/phosphor-host')
    const node = realpathSync(execPath)
    const bundle = realpathSync(bundlePath)
    const folder = dirname(dirname(bundle))
    const version = folder.slice(join(lib, 'versions').length + 1)
    if (
      !HOST_RELEASE_VERSION_PATTERN.test(version) ||
      folder !== join(lib, 'versions', version) ||
      node !== join(folder, 'node/bin/node') ||
      bundle !== join(folder, 'lib/phosphor.mjs') ||
      !lstatSync(join(lib, 'current')).isSymbolicLink() ||
      realpathSync(join(lib, 'current')) !== folder
    )
      return null
    for (const path of [join(home, '.local'), dirname(lib), lib, join(lib, 'versions'), folder]) {
      if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) return null
    }
    return { lib, version, current: join(lib, 'current') }
  } catch {
    return null
  }
}
export function serviceProgram(
  node: string,
  bundle: string,
  home: string,
): { node: string; bundle: string } {
  const layout = installedLayout(node, bundle, home)
  return layout
    ? {
        node: join(layout.current, 'node/bin/node'),
        bundle: join(layout.current, 'lib/phosphor.mjs'),
      }
    : { node, bundle }
}
export const INSTALL_COMMAND = `curl -fsSL ${HOST_RELEASE_BASE_URL}/host-latest/install.sh | sh`
export function commandLayout(
  home: string,
  node = process.execPath,
  bundle = resolve(process.argv[1] ?? ''),
) {
  return installedLayout(node, bundle, home)
}

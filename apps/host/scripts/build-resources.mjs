// What the Host carries beside its bundle: node-pty for the target when a
// folder is given, pi's bundled extensions with Desktop's filter, and the
// skills, copied whole. The build fails when pi-ext lacks one of the six.
import { cpSync, existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { validateNative } from '../../../tools/host-release/build-native.mjs'

/** Desktop's filter for pi-ext: every folder, and every `.ts` file but tests. */
export function isExtensionSource(source) {
  return statSync(source).isDirectory() || (source.endsWith('.ts') && !source.endsWith('.test.ts'))
}

/**
 * Copy the node-pty folder `native`, relative to the working folder, into
 * `stage` once it checks out for `target`, by default this machine's.
 */
export function stageNative(stage, native, target) {
  validateNative(resolve(native), target ?? `${process.platform}-${process.arch}`)
  cpSync(resolve(native), join(stage, 'native/node-pty'), { recursive: true })
}

/**
 * Copy the Host's resources from `root` into `stage`: node-pty when `native`
 * names a folder, then pi-ext and the skills. Throws when pi-ext lacks one
 * of the bundled extensions.
 */
export async function stageResources(stage, { root, native, target }) {
  if (native) stageNative(stage, native, target)
  // Every session loads these from <bundle folder>/pi-ext, with Desktop's filter.
  cpSync(join(root, 'libs/pi-extensions/pi-ext'), join(stage, 'pi-ext'), {
    recursive: true,
    filter: isExtensionSource,
  })
  cpSync(join(root, 'libs/pi-extensions/skills'), join(stage, 'skills'), { recursive: true })
  const missing = (await bundledExtensionFiles(root)).filter(
    (file) => !existsSync(join(stage, 'pi-ext', file)),
  )
  if (missing.length > 0) throw new Error(`pi-ext lacks ${missing.join(', ')}`)
}

/** The six extensions, read from the library under `root` rather than restated here. */
export async function bundledExtensionFiles(root) {
  const listing = await build({
    absWorkingDir: root,
    stdin: {
      contents:
        "export { BUNDLED_EXTENSION_FILES } from '@phosphor/session-runtime/bundled-extensions'",
      resolveDir: root,
      loader: 'ts',
    },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'warning',
  })
  const source = listing.outputFiles[0].text
  const module = await import(`data:text/javascript,${encodeURIComponent(source)}`)
  return [...module.BUNDLED_EXTENSION_FILES]
}

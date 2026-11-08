// What the Host carries beside its bundle: node-pty for the target when a
// folder is given, pi's bundled extensions with Desktop's filter, the
// skills, copied whole, and Brain's standalone bundles in brain-ext/. The
// build fails when pi-ext lacks one of the seven or a Brain source.
import { cpSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { validateNative } from '../../../tools/host-release/build-native.mjs'
import {
  BRAIN_EXTENSION_SOURCES,
  buildBrainExtensions,
} from '../../../tools/scripts/build-brain-extensions.mjs'

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
  // Never inherit an ESM parent's package boundary for node-pty's CommonJS JS.
  writeFileSync(join(stage, 'native/node-pty/package.json'), '{"private":true,"type":"commonjs"}\n')
}

/**
 * Copy the Host's resources from `root` into `stage`: node-pty when `native`
 * names a folder, then pi-ext, the skills and Brain's bundles. Throws when
 * pi-ext lacks one of the bundled extensions or a Brain source.
 */
export async function stageResources(stage, { root, native, target }) {
  if (native) stageNative(stage, native, target)
  const piExt = join(root, 'libs/pi-extensions/pi-ext')
  // Brain's sources import workspace packages; only their bundles ship.
  const brainSources = new Set(
    readdirSync(piExt)
      .filter((file) => file.startsWith('brain') && file.endsWith('.ts'))
      .map((file) => join(piExt, file)),
  )
  // Every session loads these from <bundle folder>/pi-ext, with Desktop's filter.
  cpSync(piExt, join(stage, 'pi-ext'), {
    recursive: true,
    filter: (source) => isExtensionSource(source) && !brainSources.has(source),
  })
  cpSync(join(root, 'libs/pi-extensions/skills'), join(stage, 'skills'), { recursive: true })
  const missing = [
    ...(await bundledExtensionFiles(root)).filter(
      (file) => !existsSync(join(stage, 'pi-ext', file)),
    ),
    ...BRAIN_EXTENSION_SOURCES.filter((file) => !existsSync(join(piExt, file))),
  ]
  if (missing.length > 0) throw new Error(`pi-ext lacks ${missing.join(', ')}`)
  // Staged, never enabled: no Host session lists a Brain extension.
  await buildBrainExtensions({ root, outDir: join(stage, 'brain-ext') })
}

/** The seven extensions, read from the library under `root` rather than restated here. */
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

import { mkdir } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

/** The pi-ext sources that ship only as these bundles, never as raw TypeScript. */
export const BRAIN_EXTENSION_SOURCES = [
  'brain.ts',
  'brain-processor.ts',
  'brain-learning-carrier.ts',
]

/** One staging path for dev, Desktop packaging and Host resources. No workspace imports survive. */
export async function buildBrainExtensions({ root, outDir }) {
  await mkdir(outDir, { recursive: true })
  const result = await build({
    absWorkingDir: root,
    entryPoints: Object.fromEntries(
      BRAIN_EXTENSION_SOURCES.map((file) => [
        file.slice(0, -'.ts'.length),
        `libs/pi-extensions/pi-ext/${file}`,
      ]),
    ),
    outdir: outDir,
    outExtension: { '.js': '.mjs' },
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    sourcemap: false,
    metafile: true,
    logLevel: 'warning',
    alias: {
      '@phosphor/brain-client': join(root, 'libs/brain-client/src'),
      '@phosphor/shared': join(root, 'libs/shared/src'),
    },
  })
  const foreign = Object.values(result.metafile.outputs).flatMap((output) =>
    output.imports.filter((entry) => !isBuiltin(entry.path)).map((entry) => entry.path),
  )
  if (foreign.length)
    throw new Error(`Brain extension has unbundled imports: ${foreign.join(', ')}`)
}

const here = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === here) {
  const root = resolve(dirname(here), '../..')
  await buildBrainExtensions({ root, outDir: join(root, 'libs/pi-extensions/brain-ext') })
}

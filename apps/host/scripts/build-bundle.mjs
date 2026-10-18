// The Host's one ESM file for plain Node. esbuild bundles apps/host/src/main.ts
// and refuses Electron and node-pty while resolving. The metafile is then
// audited: no forbidden package, Desktop or site file among its inputs, and
// nothing but Node builtins among its imports.
import { isBuiltin } from 'node:module'
import { join } from 'node:path'
import { build } from 'esbuild'

export const NODE_TARGET = 'node22'
export const OUTFILE = 'phosphor.mjs'
/** Modules and folders the Host must never carry. */
export const FORBIDDEN = [
  /(^|\/)node_modules\/(electron|electron-store|electron-updater|node-pty)\//,
  /^apps\/(desktop|site)\//,
]

/** ws's optional native helpers become a module that throws, so ws runs its plain JS. */
export const wsPlainJs = {
  name: 'ws-plain-js',
  setup(b) {
    b.onResolve({ filter: /^(bufferutil|utf-8-validate)$/ }, (args) => ({
      path: args.path,
      namespace: 'ws-optional',
    }))
    b.onLoad({ filter: /.*/, namespace: 'ws-optional' }, () => ({
      contents: 'throw new Error("Optional native helper disabled")',
    }))
  },
}

/**
 * A plugin that refuses every import of Electron, its stores or node-pty, and
 * `reached()`: the first refusal, which every later refusal repeats, or null.
 */
export function hostBoundary() {
  let reached = null
  const plugin = {
    name: 'host-boundary',
    setup(b) {
      b.onResolve(
        { filter: /^(electron|electron-store|electron-updater|node-pty)(\/|$)/ },
        (args) => {
          reached ??= `the Host reached ${args.path} from ${args.importer}`
          return { errors: [{ text: reached }] }
        },
      )
    },
  }
  return { plugin, reached: () => reached }
}

/**
 * esbuild's options for the bundle in `stage`, built from `root`. A release
 * build has no source map. The commit and release version are stamped when set.
 */
export function bundleOptions({ root, stage, stamped, releaseVersion, plugins }) {
  return {
    absWorkingDir: root,
    entryPoints: ['apps/host/src/main.ts'],
    outfile: join(stage, OUTFILE),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: NODE_TARGET,
    sourcemap: releaseVersion === undefined ? 'linked' : false,
    metafile: true,
    logLevel: 'warning',
    // Library source still uses the @shared/* alias internally.
    tsconfigRaw: { compilerOptions: { paths: { '@shared/*': ['./libs/shared/src/*'] } } },
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    define: {
      ...(stamped ? { __PHOSPHOR_HOST_SOURCE_SHA__: JSON.stringify(stamped) } : {}),
      ...(releaseVersion
        ? { __PHOSPHOR_HOST_RELEASE_VERSION__: JSON.stringify(releaseVersion) }
        : {}),
    },
    plugins,
  }
}

/** Throws when the bundle read a forbidden input, then when it imports anything but a builtin. */
export function auditMetafile(metafile) {
  const inputs = Object.keys(metafile.inputs)
  const reached = inputs.filter((input) => FORBIDDEN.some((pattern) => pattern.test(input)))
  if (reached.length > 0) throw new Error(`the Host bundled ${reached.join(', ')}`)
  const imports = Object.values(metafile.outputs).flatMap((output) =>
    output.imports.map((entry) => entry.path),
  )
  const foreign = [...new Set(imports.filter((path) => !isBuiltin(path)))]
  if (foreign.length > 0) {
    throw new Error(`the bundle imports ${foreign.join(', ')}, which are not Node builtins`)
  }
}

/**
 * Bundle the Host from `root` into `stage` and audit it. Returns every input
 * esbuild read. A boundary refusal throws as that refusal alone.
 */
export async function bundleHost(stage, { root, stamped, releaseVersion }) {
  const boundary = hostBoundary()
  const plugins = [wsPlainJs, boundary.plugin]
  const result = await build(
    bundleOptions({ root, stage, stamped, releaseVersion, plugins }),
  ).catch((error) => {
    throw boundary.reached() ? new Error(boundary.reached()) : error
  })
  auditMetafile(result.metafile)
  return Object.keys(result.metafile.inputs)
}

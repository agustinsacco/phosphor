// Build the Host: one ESM file for plain Node, pi's bundled extensions beside
// it, and BUILD-INFO.json listing every file with its size and sha256.
//
//   node apps/host/scripts/build.mjs [--out DIR] [--sha SHA]
//
// DIR defaults to apps/host/dist. SHA, the source commit stamped into the
// version, defaults to git's HEAD. The build fails, leaving DIR as it was,
// when the bundle reaches Electron, a native Desktop module or another app,
// imports anything but a Node builtin, or lacks one of the six extensions.
// It builds in a fresh folder beside DIR and moves it into place at the end,
// and it replaces DIR only when DIR is empty or an earlier build: a
// BUILD-INFO.json of this Host listing every file DIR holds.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const NODE_TARGET = 'node22'
const OUTFILE = 'phosphor.mjs'
const INFO = 'BUILD-INFO.json'
/** Modules and folders the Host must never carry. */
const FORBIDDEN = [
  /(^|\/)node_modules\/(electron|electron-store|electron-updater|node-pty)\//,
  /^apps\/(desktop|site)\//,
]

const { values } = parseArgs({ options: { out: { type: 'string' }, sha: { type: 'string' } } })
const out = resolve(values.out ?? join(ROOT, 'apps/host/dist'))
const sha = values.sha ?? git('rev-parse', 'HEAD')
const stamped = typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null

const refusal = replaceRefusal(out)
if (refusal) {
  console.error(`build: ${out} ${refusal}: refusing to replace it`)
  process.exit(1)
}
mkdirSync(dirname(out), { recursive: true })
// A sibling, so the source map's relative paths still hold once it is moved.
// Only this folder, which the build made, is ever removed on a failure.
const stage = mkdtempSync(join(dirname(out), '.phosphor-build-'))

const result = await build({
  absWorkingDir: ROOT,
  entryPoints: ['apps/host/src/main.ts'],
  outfile: join(stage, OUTFILE),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: NODE_TARGET,
  sourcemap: 'linked',
  metafile: true,
  logLevel: 'warning',
  // Library source still uses the @shared/* alias internally.
  tsconfigRaw: { compilerOptions: { paths: { '@shared/*': ['./libs/shared/src/*'] } } },
  define: stamped ? { __PHOSPHOR_HOST_SOURCE_SHA__: JSON.stringify(stamped) } : {},
  plugins: [
    {
      name: 'host-boundary',
      setup(b) {
        b.onResolve(
          { filter: /^(electron|electron-store|electron-updater|node-pty)(\/|$)/ },
          (args) => fail(`the Host reached ${args.path} from ${args.importer}`),
        )
      },
    },
  ],
}).catch((error) => fail(error instanceof Error ? error.message : String(error)))

const inputs = Object.keys(result.metafile.inputs)
const reached = inputs.filter((input) => FORBIDDEN.some((pattern) => pattern.test(input)))
if (reached.length > 0) fail(`the Host bundled ${reached.join(', ')}`)
const imports = Object.values(result.metafile.outputs).flatMap((output) =>
  output.imports.map((entry) => entry.path),
)
const foreign = [...new Set(imports.filter((path) => !isBuiltin(path)))]
if (foreign.length > 0)
  fail(`the bundle imports ${foreign.join(', ')}, which are not Node builtins`)

// Every session loads these from <bundle folder>/pi-ext, with Desktop's filter.
cpSync(join(ROOT, 'libs/pi-extensions/pi-ext'), join(stage, 'pi-ext'), {
  recursive: true,
  filter: (source) =>
    statSync(source).isDirectory() || (source.endsWith('.ts') && !source.endsWith('.test.ts')),
})
const missing = (await bundledExtensionFiles()).filter(
  (file) => !existsSync(join(stage, 'pi-ext', file)),
)
if (missing.length > 0) fail(`pi-ext lacks ${missing.join(', ')}`)

const files = readdirSync(stage, { recursive: true, encoding: 'utf8' })
  .filter((file) => statSync(join(stage, file)).isFile())
  .sort()
  .map((file) => {
    const bytes = readFileSync(join(stage, file))
    return {
      path: file,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
const info = {
  schema: 1,
  name: 'phosphor',
  version: `0.0.0-dev.${stamped?.slice(0, 7) ?? 'source'}`,
  sourceSha: stamped,
  sourceDirty: stamped ? git('status', '--porcelain') !== '' : null,
  nodeTarget: NODE_TARGET,
  entry: OUTFILE,
  files,
}
writeFileSync(join(stage, INFO), `${JSON.stringify(info, null, 2)}\n`)
// Checked again: the folder may have changed while the build ran.
const late = replaceRefusal(out)
if (late) fail(`${out} ${late}: refusing to replace it`)
rmSync(out, { recursive: true, force: true })
renameSync(stage, out)
console.log(
  `${relative(process.cwd(), out) || '.'}: ${info.version}, ${files.length} files, ${inputs.length} inputs`,
)

/**
 * Why `dir` may not be replaced, or null. It may be when it does not exist,
 * is empty, or is an earlier build: a real folder whose BUILD-INFO.json, a
 * regular file, is this Host's manifest and lists every other file in it.
 * A link anywhere in it is refused.
 */
function replaceRefusal(dir) {
  if (!existsSync(dir)) return null
  if (!lstatSync(dir).isDirectory()) return 'is not a folder'
  const entries = readdirSync(dir, { recursive: true, encoding: 'utf8' })
  if (entries.length === 0) return null
  const link = entries.find((entry) => lstatSync(join(dir, entry)).isSymbolicLink())
  if (link !== undefined) return `holds a link, ${link}`
  const marker = join(dir, INFO)
  if (!existsSync(marker) || !lstatSync(marker).isFile()) return `holds no ${INFO} file`
  let listed
  try {
    const manifest = JSON.parse(readFileSync(marker, 'utf8'))
    if (manifest.schema !== 1 || manifest.name !== 'phosphor' || !Array.isArray(manifest.files)) {
      return `holds a ${INFO} that is not this Host's`
    }
    listed = new Set(manifest.files.map((file) => file.path))
  } catch {
    return `holds a ${INFO} that is not JSON`
  }
  const unlisted = entries.find(
    (entry) => entry !== INFO && lstatSync(join(dir, entry)).isFile() && !listed.has(entry),
  )
  return unlisted === undefined ? null : `holds ${unlisted}, which its ${INFO} does not list`
}

/** The six extensions, read from the library itself rather than restated here. */
async function bundledExtensionFiles() {
  const listing = await build({
    absWorkingDir: ROOT,
    stdin: {
      contents:
        "export { BUNDLED_EXTENSION_FILES } from '@phosphor/session-runtime/bundled-extensions'",
      resolveDir: ROOT,
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

function git(...args) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return null
  }
}

function fail(message) {
  rmSync(stage, { recursive: true, force: true })
  console.error(`build: ${message}`)
  process.exit(1)
}

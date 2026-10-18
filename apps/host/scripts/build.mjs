// Build the Host: one ESM file for plain Node, pi's bundled extensions beside
// it, and BUILD-INFO.json listing every file with its size and sha256.
//
//   node apps/host/scripts/build.mjs [--out DIR] [--sha SHA]
//
// DIR defaults to apps/host/dist. SHA, the source commit stamped into the
// version, defaults to git's HEAD. The build fails, leaving DIR as it was,
// when the bundle reaches Electron, a native Desktop module or another app,
// imports anything but a Node builtin, or lacks one of the six extensions.
// It replaces DIR only when DIR is empty or an earlier build (output.mjs).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { bundleHost, NODE_TARGET, OUTFILE } from './build-bundle.mjs'
import { stageResources } from './build-resources.mjs'
import { buildInto, INFO } from './output.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const { values } = parseArgs({
  options: {
    out: { type: 'string' },
    sha: { type: 'string' },
    native: { type: 'string' },
    target: { type: 'string' },
  },
})
const out = resolve(values.out ?? join(ROOT, 'apps/host/dist'))
const sha = values.sha ?? git('rev-parse', 'HEAD')
const releaseVersion = process.env.HOST_RELEASE_VERSION
if (
  releaseVersion !== undefined &&
  !/^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.test(releaseVersion)
) {
  console.error('build: invalid HOST_RELEASE_VERSION')
  process.exit(1)
}
const stamped = typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null

let built
try {
  built = await buildInto(out, stageBuild)
} catch (error) {
  console.error(`build: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
const { info, inputs } = built.value
if (built.kept) console.error(`build: the earlier build could not be deleted: ${built.kept}`)
console.log(
  `${relative(process.cwd(), out) || '.'}: ${info.version}, ${info.files.length} files, ${inputs} inputs`,
)

/** Build into `stage`, which holds nothing yet. Any failure throws. */
async function stageBuild(stage) {
  const inputs = await bundleHost(stage, { root: ROOT, stamped, releaseVersion })
  await stageResources(stage, { root: ROOT, native: values.native, target: values.target })

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
    version: releaseVersion ?? `0.0.0-dev.${stamped?.slice(0, 7) ?? 'source'}`,
    sourceSha: stamped,
    sourceDirty: stamped
      ? git(
          'status',
          '--porcelain',
          ...(releaseVersion === undefined ? [] : ['--untracked-files=no']),
        ) !== ''
      : null,
    nodeTarget: NODE_TARGET,
    entry: OUTFILE,
    files,
  }
  writeFileSync(join(stage, INFO), `${JSON.stringify(info, null, 2)}\n`)
  return { info, inputs: inputs.length }
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

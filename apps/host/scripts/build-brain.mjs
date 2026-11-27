import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { auditMetafile, bundleOptions, hostBoundary } from './build-bundle.mjs'
import { stageBrainDependencies, TRANSFORMERS_PACKAGE } from './brain-package-files.mjs'

function options(root) {
  return { absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', target: 'node22' }
}

export async function brainContract(root) {
  const result = await build({
    ...options(root),
    stdin: {
      contents: `export * from './apps/host/src/brain/packaged-runtime';
        export { embeddingPlatformSupported } from '@phosphor/brain-runtime/embedding/model-manifest';
        export { unverifiedFiles } from '@phosphor/brain-runtime/embedding/embedding-files';`,
      resolveDir: root,
    },
    write: false,
  })
  return import(`data:text/javascript,${encodeURIComponent(result.outputFiles[0].text)}`)
}

const transformers = {
  name: 'staged-transformers',
  setup(b) {
    b.onResolve({ filter: /^@huggingface\/transformers$/ }, () => ({
      path: TRANSFORMERS_PACKAGE,
      external: true,
    }))
  },
}

async function bundleWorkers(root, dir, contract) {
  const boundary = hostBoundary()
  const { metafile } = await build({
    ...bundleOptions({ root, stage: dir, plugins: [transformers, boundary.plugin] }),
    outfile: undefined,
    outdir: dir,
    sourcemap: false,
    entryPoints: [
      {
        in: 'apps/host/src/brain/search-worker.ts',
        out: contract.BRAIN_SEARCH_WORKER.slice(0, -3),
      },
      {
        in: 'apps/host/src/brain/embedding-worker.ts',
        out: contract.BRAIN_EMBEDDING_WORKER.slice(0, -3),
      },
    ],
  })
  for (const [name, output] of Object.entries(metafile.outputs)) {
    // The only non-builtin import belongs to the embedding worker; even that
    // worker must find it in the archive, never in a machine's global setup.
    if (name.endsWith(`/${contract.BRAIN_EMBEDDING_WORKER}`))
      output.imports = output.imports.filter((entry) => entry.path !== TRANSFORMERS_PACKAGE)
  }
  auditMetafile(metafile)
}

export async function prepareBrain(root, target, model, smoke, node) {
  if (!model && !smoke) return null
  if (model && smoke)
    throw new Error('Choose real-model qualification or synthetic smoke, not both')
  const contract = await brainContract(root)
  const [platform, arch, extra] = (target ?? '').split('-')
  if (extra !== undefined || !contract.embeddingPlatformSupported(platform, arch))
    throw new Error(`Host Brain is not supported on ${target ?? 'an unspecified target'}`)
  if (target !== `${process.platform}-${process.arch}`)
    throw new Error('Host Brain must be built and verified on its target platform')
  if (model && (await contract.unverifiedFiles(resolve(model))).length > 0)
    throw new Error('The offline Host Brain model is missing files or failed manifest verification')
  const qualification = contract.brainQualification(target)
  if (
    !node ||
    execFileSync(resolve(node), ['--version'], { encoding: 'utf8' }).trim() !==
      `v${qualification.node}`
  )
    throw new Error(`Host Brain requires bundled Node ${qualification.node}`)
  return { contract, qualification, model: model && resolve(model), node: resolve(node) }
}

export async function stageBrain(stage, root, config) {
  const { contract, model, node, qualification } = config
  const dir = join(stage, contract.BRAIN_WORKER_DIR)
  mkdirSync(dir)
  writeFileSync(join(dir, 'package.json'), '{"private":true,"type":"module"}\n')
  await bundleWorkers(root, dir, contract)
  stageBrainDependencies(stage, root)
  if (model) {
    await runBrainSmoke(root, stage, node, model)
    writeFileSync(join(dir, contract.BRAIN_QUALIFICATION), `${JSON.stringify(qualification)}\n`)
  }
}

/** A disposable probe bundled at build time – not a shipped command or resource. */
export async function runBrainSmoke(root, stage, node, model) {
  const result = await build({
    ...options(root),
    entryPoints: ['apps/host/scripts/brain-smoke.ts'],
    write: false,
  })
  execFileSync(
    resolve(node),
    ['--input-type=module', '-', resolve(stage), ...(model ? [model] : [])],
    {
      cwd: stage,
      env: { PATH: '/usr/bin:/bin' },
      input: result.outputFiles[0].text,
      timeout: 180_000,
      stdio: ['pipe', 'inherit', 'inherit'],
    },
  )
}

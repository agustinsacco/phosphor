import { lstatSync, realpathSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { readBounded } from '@phosphor/session-runtime/host-install/files'
import {
  EMBEDDING_MODEL,
  embeddingPlatformSupported,
} from '@phosphor/brain-runtime/embedding/model-manifest'
import nodePin from './node.json'

export const BRAIN_WORKER_DIR = 'brain-workers'
export const BRAIN_SEARCH_WORKER = 'brain-search-worker.js'
export const BRAIN_EMBEDDING_WORKER = 'brain-embedding-worker.js'
export const packagedNodeVersion = `v${nodePin.version}`
export const BRAIN_QUALIFICATION = 'QUALIFIED.json'

const REQUIRED_FILES = [
  BRAIN_SEARCH_WORKER,
  BRAIN_EMBEDDING_WORKER,
  'package.json',
  '../brain-ext/brain.mjs',
  '../brain-ext/brain-curator.mjs',
  '../brain-ext/brain-fork-guard.mjs',
  '../brain-ext/brain-agent-guard.mjs',
  '../skills/brain/SKILL.md',
  '../node_modules/brain-transformers/dist/transformers.node.mjs',
  '../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/onnxruntime_binding.node',
  '../node_modules/onnxruntime-node/bin/napi-v6/darwin/arm64/libonnxruntime.1.dylib',
  '../node_modules/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.5.node',
  '../node_modules/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.7.dylib',
]

export function brainQualification(target: string) {
  return { target, node: nodePin.version, modelRevision: EMBEDDING_MODEL.revision }
}

/** Package readiness, not model availability. No code is loaded and no data is opened. */
export function resolvePackagedBrainRuntime(
  resourceRoot: string,
  runtime: Pick<NodeJS.Process, 'platform' | 'arch' | 'version'> = process,
): { searchWorker: string; embeddingWorker: string } | null {
  if (!embeddingPlatformSupported(runtime.platform, runtime.arch)) return null
  const proof = brainQualification(`${runtime.platform}-${runtime.arch}`)
  if (runtime.version !== `v${proof.node}`) return null
  const dir = join(resourceRoot, BRAIN_WORKER_DIR)
  try {
    const marker = join(dir, BRAIN_QUALIFICATION)
    const canonical = realpathSync(resourceRoot)
    const plainFile = (file: string) =>
      realpathSync(file) === resolve(canonical, relative(resourceRoot, file)) &&
      lstatSync(file).isFile()
    if (!plainFile(marker)) return null
    const contents = readBounded(marker, 512)
    if (contents !== `${JSON.stringify(proof)}\n`) return null
    if (!REQUIRED_FILES.every((file) => plainFile(join(dir, file)))) return null
    return {
      searchWorker: join(dir, BRAIN_SEARCH_WORKER),
      embeddingWorker: join(dir, BRAIN_EMBEDDING_WORKER),
    }
  } catch {
    return null
  }
}

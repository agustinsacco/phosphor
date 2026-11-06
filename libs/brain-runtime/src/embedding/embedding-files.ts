import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { downloadFiles, pruneDir, type ModelFile } from '@phosphor/session-runtime/model-download'
import { EMBEDDING_MODEL } from './model-manifest'

/**
 * The embedding model on disk.
 *
 * `<directory>/embedding-models/<name>/` only ever holds a complete set that
 * matched every pinned SHA-256 when it was moved there. Downloads go to a
 * sibling `.staging-<name>/` through the shared verified downloader
 * (per-file `.part` + rename), then every file is hashed again, same-size
 * corruption included, before one directory rename publishes the set. A failed
 * attempt keeps the staged files that still verify, so a retry resumes.
 */
export interface EmbeddingModelPaths {
  /** Transformers.js `localModelPath`. */
  root: string
  model: string
  staging: string
}

export function embeddingModelPaths(directory: string): EmbeddingModelPaths {
  const root = join(directory, 'embedding-models')
  const name = EMBEDDING_MODEL.directoryName
  return { root, model: join(root, name), staging: join(root, `.staging-${name}`) }
}

async function sha256File(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/** Relative paths of the files that are missing or do not match the manifest. */
export async function unverifiedFiles(
  dir: string,
  files: readonly ModelFile[] = EMBEDDING_MODEL.files,
  signal?: AbortSignal,
): Promise<string[]> {
  const bad: string[] = []
  for (const file of files) {
    signal?.throwIfAborted()
    const path = join(dir, file.path)
    const info = await stat(path).catch(() => null)
    if (info?.isFile() !== true || info.size !== file.bytes) {
      bad.push(file.path)
    } else if ((await sha256File(path, signal)) !== file.sha256) {
      bad.push(file.path)
    }
  }
  return bad
}

export interface InstallOptions {
  signal: AbortSignal
  fetch?: typeof fetch
  onProgress?: (receivedBytes: number) => void
  /** Called once the download is complete and the full re-hash starts. */
  onVerifying?: () => void
  /** The pinned manifest unless a test substitutes small files. */
  files?: readonly ModelFile[]
}

/**
 * Download, verify and publish the model. Resolves once `paths.model` holds
 * the verified set; rejects (leaving no unverified file at a final path)
 * on any network, size, hash or abort failure.
 */
export async function installEmbeddingModel(
  paths: EmbeddingModelPaths,
  options: InstallOptions,
): Promise<void> {
  const files = options.files ?? EMBEDDING_MODEL.files
  await mkdir(paths.root, { recursive: true })
  // A published set that went bad is reused as staging: its good files stay.
  if (await stat(paths.model).catch(() => null)) {
    await rm(paths.staging, { recursive: true, force: true })
    await rename(paths.model, paths.staging)
  }
  await mkdir(paths.staging, { recursive: true })
  // `.part` files a killed process left behind, and anything not in the manifest.
  await pruneDir(
    paths.staging,
    files.map((file) => file.path),
  )
  // The downloader skips a file of the right size; drop same-size corruption first.
  for (const path of await unverifiedFiles(paths.staging, files, options.signal)) {
    await rm(join(paths.staging, path), { force: true })
  }
  await downloadFiles(paths.staging, [...files], {
    signal: options.signal,
    fetch: options.fetch,
    onProgress: options.onProgress,
  })
  options.onVerifying?.()
  const bad = await unverifiedFiles(paths.staging, files, options.signal)
  if (bad.length > 0) throw new Error(`Model files failed verification: ${bad.join(', ')}`)
  options.signal.throwIfAborted()
  await rename(paths.staging, paths.model)
}

/** Delete the model and any staged download. Other files in `directory` are untouched. */
export async function removeEmbeddingModel(paths: EmbeddingModelPaths): Promise<void> {
  await rm(paths.staging, { recursive: true, force: true })
  await rm(paths.model, { recursive: true, force: true })
}

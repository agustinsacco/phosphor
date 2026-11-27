/**
 * The production ports a Host needs before it offers to take This Mac's Desktop Brain
 * (docs/brain-handover.md). Built by whoever composes `run` (the native Brain's owner) and passed
 * to `brainHandoverOwnerHandlers`; without them the Host never offers a move.
 *
 * - Preflight (`readerReadiness`): this bundle's Brain runtime is qualified for this target and
 *   Node (`resolvePackagedBrainRuntime`), and pi is an absolute runnable file. No credentials,
 *   provider calls, model files or network.
 * - Final readiness (`probeModel`): the packaged embedding worker loads the sealed model after
 *   every pinned hash matches and embeds invented text, through the same controller a running
 *   Brain uses. Missing or wrong files fail before any worker starts; `fetch` always refuses, so
 *   nothing downloads and no terms are accepted on the owner's behalf.
 */
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import { isAbsolute } from 'node:path'
import type { EmbeddingProcess } from '@phosphor/brain-runtime/embedding/embedding-client'
import { createEmbeddingController } from '@phosphor/brain-runtime/embedding/embedding-controller'
import {
  embeddingModelPaths,
  unverifiedFiles,
} from '@phosphor/brain-runtime/embedding/embedding-files'
import { EMBEDDING_MODEL, embeddingThreads } from '@phosphor/brain-runtime/embedding/model-manifest'
import type {
  FromEmbeddingWorker,
  ToEmbeddingWorker,
} from '@phosphor/brain-runtime/embedding/embedding-protocol'
import type { BrainReaderReadiness } from '@phosphor/shared/host-protocol-owner'
import { resolvePackagedBrainRuntime } from '../brain/packaged-runtime'
import { forkBrainWorker } from '../brain/worker-process'
import { createBrainAgentTranscriptImport, type BrainAgentBindingPort } from './agent-import'
import type { BrainHandoverNativePorts } from './owner-seam'

/** The same heap a running Brain's embedding worker gets. */
const PROBE_HEAP_MB = 1024

export interface BrainHandoverNativeInput {
  /** The folder holding `brain-workers/`, `brain-ext/` and `skills/`. */
  readonly resourceRoot: string
  /** How the Host starts pi (`machine.pi`). */
  readonly pi: { readonly binaryPath: string; readonly prefixArgs: readonly string[] }
  /** `piSessionsRoot(env)` of the Host's lanes. */
  readonly sessionsRoot: string
  /** The reserved Brain lane's binding, from its owner. */
  readonly agentBinding: BrainAgentBindingPort
  readonly log: (message: string) => void
  /** Tests only. */
  readonly runtime?: Pick<NodeJS.Process, 'platform' | 'arch' | 'version'>
  readonly spawn?: (workerPath: string) => EmbeddingProcess
  readonly fetch?: typeof fetch
}

async function runnable(path: string | undefined): Promise<boolean> {
  if (!path || !isAbsolute(path)) return false
  try {
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

const refuseFetch: typeof fetch = () =>
  Promise.reject(new Error('A Brain handover never downloads a model.'))

export function createBrainHandoverNativePorts(
  input: BrainHandoverNativeInput,
): Required<BrainHandoverNativePorts> {
  const packaged = () => resolvePackagedBrainRuntime(input.resourceRoot, input.runtime)
  const spawn =
    input.spawn ??
    ((workerPath: string) =>
      forkBrainWorker<ToEmbeddingWorker, FromEmbeddingWorker>({
        workerPath,
        heapMb: PROBE_HEAP_MB,
        log: input.log,
      }))

  async function readerReadiness(): Promise<BrainReaderReadiness> {
    if (!packaged()) return 'unqualified'
    const script = input.pi.prefixArgs.find((arg) => !arg.startsWith('-'))
    const pi = (await runnable(input.pi.binaryPath)) && (script === undefined || isAbsolute(script))
    if (!pi) return 'unavailable'
    if (
      script !== undefined &&
      !(await stat(script).then(
        (s) => s.isFile(),
        () => false,
      ))
    )
      return 'unavailable'
    return 'qualified'
  }

  async function probeModel(directory: string): Promise<boolean> {
    const runtime = packaged()
    if (!runtime) return false
    const paths = embeddingModelPaths(directory)
    // activate() downloads into a missing folder: only a complete, pinned set reaches it.
    if (
      !(await stat(paths.model).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      return false
    if ((await unverifiedFiles(paths.model)).length > 0) return false
    const controller = createEmbeddingController({
      directory,
      supported: true,
      threads: embeddingThreads(availableParallelism()),
      spawn: () => spawn(runtime.embeddingWorker),
      fetch: input.fetch ?? refuseFetch,
      log: input.log,
    })
    try {
      // Hashes again, loads the model in a fresh worker and self-tests it on invented text.
      await controller.setEnabled(true)
      return controller.status().phase === 'ready'
    } catch {
      return false
    } finally {
      controller.dispose()
    }
  }

  return {
    readerReadiness,
    probeModel,
    embeddingModel: {
      directoryName: EMBEDDING_MODEL.directoryName,
      files: EMBEDDING_MODEL.files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 })),
    },
    importAgentTranscripts: createBrainAgentTranscriptImport({
      sessionsRoot: input.sessionsRoot,
      binding: input.agentBinding,
    }),
  }
}

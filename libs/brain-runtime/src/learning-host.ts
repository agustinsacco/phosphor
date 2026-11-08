import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrainLearningBinding,
  BrainLearningCheckpoint,
  BrainLearningEvidence,
  BrainLearningSource,
} from '@phosphor/shared/brain-learning'
import type { BrainLearningTarget } from '@phosphor/shared/brain-learning-jobs'
import type { LearningExecutionProfile } from '@phosphor/session-runtime/pi/learning-execution-profile'
import type { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import type { BrainLearningHost, PreparedBrainLearning } from './learning-port'
import {
  admitLearningSource,
  type LearningSourceAdmissionRuntime,
  type LearningSourceSelection,
} from './learning-source-admission'
import { writeLearningControl } from './learning-carrier-files'
import { createLearningRoot, withLearningRootRecovery } from './learning-carrier-recovery'
import { OwnedLearningCarrier } from './learning-host-owner'
import { abortable } from './processor-wait'
import type { LearningSourceBinding } from './learning-source-binding'

type Resolved = Pick<
  LearningExecutionProfile,
  'agentDir' | 'binaryPath' | 'prefixArgs' | 'env' | 'providerExtension'
> & {
  accountId?: string
  claudeVersion?: string
  sourceBinding?: LearningSourceBinding
}
export interface LearningHostOptions extends LearningSourceAdmissionRuntime {
  directory: string
  extensionPath: string
  sessions: Pick<ReturnType<typeof createSessionService<undefined>>, 'create' | 'disposeBrain'>
  resolve(
    selection: LearningSourceSelection,
    target: BrainLearningTarget,
    liveSessionId: string | undefined,
    signal: AbortSignal,
    source: BrainLearningSource,
  ): Promise<Resolved>
  /** Reports cleanup failure without provider credentials/config fields. */
  onError(error: Error): void
}
export interface LearningCarrierPreview {
  authIdentityFence: string
  binding: BrainLearningBinding
  checkpoint: BrainLearningCheckpoint
  evidence: BrainLearningEvidence[]
  maxOutputTokens: number
}
/** The Desktop factory binds this to its existing session service, registry and path-lock domain. */
export function createLearningHost(
  options: LearningHostOptions,
): BrainLearningHost & { recover(): Promise<void>; dispose(): Promise<void> } {
  let current: OwnedLearningCarrier | undefined
  let admission: Promise<PreparedBrainLearning> | undefined
  let stopping: Promise<void> | undefined
  let controller: AbortController | undefined
  const recover = async (): Promise<void> => {
    if (admission) throw new Error('Learning preparation still owns private input; retry cleanup')
    if (current) {
      if (!current.closed)
        throw new Error('A learning carrier still owns private input; dispose it first')
      await current.dispose()
      current = undefined
    }
    await withLearningRootRecovery(options, async () => {})
  }
  return {
    recover,
    dispose: () => {
      stopping ??= Promise.resolve()
        .then(async () => {
          controller?.abort(new Error('Learning host cleanup requested'))
          current?.cancel()
          await admission?.catch(() => undefined)
          if (current) {
            await current.dispose()
            current = undefined
          }
          await withLearningRootRecovery(options, async () => {})
        })
        .finally(() => {
          stopping = undefined
        })
      return stopping
    },
    prepare: (target, jobId, signal) => {
      if (admission || stopping)
        return Promise.reject(new Error('One learning carrier may prepare at a time'))
      controller = new AbortController()
      admission = (async () => {
        if (current) {
          if (!current.closed) throw new Error('One learning carrier may be owned at a time')
          await current.dispose()
          current = undefined
        }
        return withLearningRootRecovery(options, () =>
          prepare(
            options,
            target,
            jobId,
            AbortSignal.any([signal, controller!.signal]),
            (owned) => {
              current = owned
            },
          ),
        )
      })().finally(() => {
        admission = undefined
        controller = undefined
      })
      return admission
    },
  }
}
function verifySourceBinding(
  selection: LearningSourceSelection,
  resolved: Resolved,
  source: BrainLearningSource,
): void {
  const binding = resolved.sourceBinding!.binding
  if (
    resolved.sourceBinding!.sessionId !== source.sessionId ||
    resolved.sourceBinding!.selectedLeafId !== source.selectedLeafId ||
    resolved.sourceBinding!.settled !== true ||
    binding.provider !== selection.provider ||
    binding.modelId !== selection.modelId ||
    binding.thinkingLevel !== selection.thinkingLevel ||
    (selection.api && binding.api !== selection.api) ||
    (resolved.accountId && binding.accountId !== resolved.accountId)
  )
    throw new Error('Learning source-process auth binding does not match selected identity')
}
function selectedForCarrier(
  selection: LearningSourceSelection,
  resolved: Resolved,
  liveSessionId: string | undefined,
  source: BrainLearningSource,
) {
  if (liveSessionId && !resolved.sourceBinding)
    throw new Error(
      'Live learning requires metadata-only source-process get_auth_binding with its actual slot, method, endpoint and authIdentityFence; a host assignment alone is insufficient.',
    )
  if (resolved.sourceBinding) verifySourceBinding(selection, resolved, source)
  return {
    ...selection,
    ...resolved.sourceBinding?.binding,
    ...(resolved.sourceBinding
      ? { authIdentityFence: resolved.sourceBinding.authIdentityFence }
      : {}),
    ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
    ...(resolved.claudeVersion ? { claudeVersion: resolved.claudeVersion } : {}),
  }
}
async function prepare(
  options: LearningHostOptions,
  target: BrainLearningTarget,
  jobId: string,
  parentSignal: AbortSignal,
  retain: (owned: OwnedLearningCarrier) => void,
): Promise<PreparedBrainLearning> {
  parentSignal.throwIfAborted()
  if (!/^[\w-]{1,128}$/.test(jobId)) throw new Error('Invalid learning job owner')
  const nonce = randomBytes(32).toString('hex')
  const root = await createLearningRoot(options.directory, jobId, nonce)
  const owned = new OwnedLearningCarrier(options, root, jobId, nonce)
  retain(owned)
  const startup = AbortSignal.any([parentSignal, AbortSignal.timeout(15000), owned.signal])
  try {
    const snapshotPath = join(root, 'source.jsonl')
    const admitted = await admitLearningSource(options, target, snapshotPath, jobId, startup)
    const resolved = await abortable(
      options.resolve(
        admitted.selection,
        target,
        admitted.liveSessionId,
        startup,
        admitted.frozen.source,
      ),
      startup,
    )
    startup.throwIfAborted()
    const cwd = join(root, 'cwd'),
      sessionDir = join(root, 'control'),
      controlFile = join(root, 'control.json')
    await Promise.all([cwd, sessionDir].map((path) => mkdir(path, { mode: 0o700 })))
    const selected = selectedForCarrier(
      admitted.selection,
      resolved,
      admitted.liveSessionId,
      admitted.frozen.source,
    )
    await writeLearningControl(controlFile, {
      version: 1,
      jobId,
      nonce,
      source: admitted.frozen.source,
      snapshotPath,
      selected,
    })
    await owned.start(
      {
        ...resolved,
        owner: { kind: 'brain', jobId },
        cwd,
        sessionDir,
        carrierExtension: options.extensionPath,
        controlFile,
        nonce,
        provider: selected.provider,
        modelId: selected.modelId,
        thinkingLevel: selected.thinkingLevel,
      },
      startup,
    )
    const preview = await owned.preflight(startup)
    startup.throwIfAborted()
    return {
      scope: admitted.scope,
      branch: admitted.branch,
      ...preview,
      run: (request, signal) => owned.run(request, preview, signal),
      dispose: () => owned.dispose(),
    }
  } catch (error) {
    await owned.dispose()
    parentSignal.throwIfAborted()
    throw error
  }
}

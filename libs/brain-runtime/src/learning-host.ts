import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  BrainLearningBinding,
  BrainLearningCheckpoint,
  BrainLearningEvidence,
  BrainLearningRequest,
  BrainLearningResult,
  BrainLearningSource,
  BrainLearningUsage,
} from '@phosphor/shared/brain-learning'
import type { BrainLearningTarget } from '@phosphor/shared/brain-learning-jobs'
import type { LearningExecutionProfile } from '@phosphor/session-runtime/pi/learning-execution-profile'
import type { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import type { PiEvent } from '@phosphor/shared/rpc'
import type { BrainLearningHost, PreparedBrainLearning } from './learning-port'
import {
  admitLearningSource,
  type LearningSourceAdmissionRuntime,
  type LearningSourceSelection,
} from './learning-source-admission'
import { commandLearningCarrier, verifyLearningCommand } from './learning-carrier-transport'
import {
  purgeLearningRoot,
  readLearningControl,
  writeLearningControl,
} from './learning-carrier-files'
import { abortable } from './processor-wait'

type Resolved = Pick<
  LearningExecutionProfile,
  'agentDir' | 'binaryPath' | 'prefixArgs' | 'env' | 'providerExtension'
> & {
  accountId?: string
  claudeVersion?: string
  sourceBinding?: {
    binding: BrainLearningBinding
    authIdentityFence: string
    sessionId: string
    selectedLeafId: string
    settled: true
  }
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
  ): Promise<Resolved>
  /** Reports cleanup failure without provider credentials/config fields. */
  onError(error: Error): void
}
interface Preview {
  authIdentityFence: string
  binding: BrainLearningBinding
  checkpoint: BrainLearningCheckpoint
  evidence: BrainLearningEvidence[]
  maxOutputTokens: number
}
/** The Desktop factory binds this to its existing session service, registry and path-lock domain. */
export function createLearningHost(options: LearningHostOptions): BrainLearningHost {
  let current: OwnedLearningCarrier | undefined
  let preparing = false
  return {
    prepare: async (target, jobId, signal) => {
      if (preparing) throw new Error('One learning carrier may prepare at a time')
      preparing = true
      try {
        if (current) {
          if (!current.closed) throw new Error('One learning carrier may be owned at a time')
          await current.dispose()
          current = undefined
        }
        return await prepare(options, target, jobId, signal, (owned) => {
          current = owned
        })
      } finally {
        preparing = false
      }
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
  await mkdir(options.directory, { recursive: true, mode: 0o700 })
  const root = await mkdtemp(join(await realpath(options.directory), 'learning-'))
  const nonce = randomBytes(32).toString('hex')
  await writeLearningControl(join(root, 'owner.json'), { jobId, nonce })
  const owned = new OwnedLearningCarrier(options, root, jobId, nonce)
  retain(owned)
  const startup = AbortSignal.any([parentSignal, AbortSignal.timeout(15000), owned.signal])
  try {
    const snapshotPath = join(root, 'source.jsonl')
    const admitted = await admitLearningSource(options, target, snapshotPath, jobId, startup)
    const resolved = await abortable(
      options.resolve(admitted.selection, target, admitted.liveSessionId, startup),
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

class OwnedLearningCarrier {
  private readonly controller = new AbortController()
  private sessionId: string | undefined
  private cleanup: Promise<void> | undefined
  private disposed = false
  private used = false
  private unwatch = () => {}
  constructor(
    private readonly options: LearningHostOptions,
    private readonly root: string,
    private readonly jobId: string,
    private readonly nonce: string,
  ) {}
  get closed(): boolean {
    return this.disposed
  }
  get signal(): AbortSignal {
    return this.controller.signal
  }
  cancel(): void {
    this.controller.abort(new Error('Learning carrier stopped'))
  }
  private live() {
    const live = this.sessionId ? this.options.registry.get(this.sessionId) : undefined
    if (
      !live ||
      live.owner?.jobId !== this.jobId ||
      live.workspacePath !== join(this.root, 'cwd') ||
      !live.client.alive ||
      this.disposed
    )
      throw new Error('Learning carrier owner is unavailable')
    return live
  }
  async start(profile: LearningExecutionProfile, signal: AbortSignal): Promise<void> {
    const creation = this.options.sessions.create({ workspacePath: profile.cwd }, undefined, {
      learning: profile,
      signal,
    })
    const tracked = creation.then(async (info) => {
      this.sessionId = info.sessionId
      if (this.disposed || signal.aborted) {
        await this.disposeLate()
        signal.throwIfAborted()
        throw new Error('Late learning startup disposed')
      }
      const live = this.live()
      const event = (value: PiEvent) => {
        if (
          ['agent_start', 'tool_execution_start', 'auto_retry_start', 'compaction_start'].includes(
            value.type,
          )
        ) {
          this.cancel()
          this.dispose().catch(() =>
            this.options.onError(new Error('Learning violation cleanup failed')),
          )
        }
      }
      live.client.on('event', event)
      this.unwatch = () => live.client.off('event', event)
    })
    await abortable(tracked, signal)
  }
  async preflight(signal: AbortSignal): Promise<Preview> {
    const client = this.live().client
    await verifyLearningCommand(client, this.options.extensionPath, signal)
    await this.operation('prepare', signal)
    const preview = await readLearningControl<Preview>(join(this.root, 'prepare-result.json'))
    if (
      !preview.binding ||
      typeof preview.authIdentityFence !== 'string' ||
      !/^[\w.:-]{1,256}$/.test(preview.authIdentityFence) ||
      !preview.checkpoint ||
      !Array.isArray(preview.evidence) ||
      !Number.isSafeInteger(preview.maxOutputTokens) ||
      preview.maxOutputTokens < 1 ||
      preview.maxOutputTokens > 32768
    )
      throw new Error('Invalid learning carrier preflight')
    return preview
  }
  private async operation(operation: 'prepare' | 'run', signal: AbortSignal): Promise<void> {
    const ok = await commandLearningCarrier(
      this.live().client,
      this.jobId,
      this.nonce,
      operation,
      signal,
    )
    if (ok) return
    const failure = await readLearningControl<{ error?: string; usage?: BrainLearningUsage }>(
      join(this.root, `${operation}-error.json`),
    )
    const error = new Error(
      typeof failure.error === 'string' ? failure.error.slice(0, 1000) : 'Learning carrier failed',
    )
    if (failure.usage) Object.assign(error, { learningUsage: failure.usage })
    throw error
  }
  async run(
    request: BrainLearningRequest,
    preview: Preview,
    parentSignal: AbortSignal,
  ): Promise<BrainLearningResult> {
    if (this.used || this.disposed) throw new Error('Learning carrier can run at most once')
    this.used = true
    const signal = AbortSignal.any([parentSignal, this.signal, AbortSignal.timeout(120000)])
    const stop = () => {
      this.cancel()
      this.dispose().catch(() =>
        this.options.onError(new Error('Learning cancellation cleanup failed')),
      )
    }
    signal.addEventListener('abort', stop, { once: true })
    try {
      signal.throwIfAborted()
      if (
        request.jobId !== this.jobId ||
        JSON.stringify(request.binding) !== JSON.stringify(preview.binding) ||
        JSON.stringify(request.source) !== JSON.stringify(preview.checkpoint.source) ||
        request.maxOutputTokens > preview.maxOutputTokens ||
        !Number.isSafeInteger(request.deadlineMs) ||
        request.deadlineMs < 1 ||
        request.deadlineMs > 120000
      )
        throw new Error('Learning request does not match the prepared source/current-slot binding')
      const deadline = AbortSignal.any([signal, AbortSignal.timeout(request.deadlineMs)])
      await writeLearningControl(join(this.root, 'request.json'), {
        request,
        authIdentityFence: preview.authIdentityFence,
      })
      await abortable(this.operation('run', deadline), deadline)
      const result = await readLearningControl<BrainLearningResult>(
        join(this.root, 'run-result.json'),
      )
      deadline.throwIfAborted()
      if (
        result.jobId !== this.jobId ||
        JSON.stringify(result.binding) !== JSON.stringify(preview.binding) ||
        result.checkpoint?.projectionDigest !== preview.checkpoint.projectionDigest
      )
        throw new Error('Learning result identity changed')
      return result
    } finally {
      signal.removeEventListener('abort', stop)
      await this.dispose()
    }
  }
  private async disposeLate(): Promise<void> {
    if (this.sessionId)
      await this.options.sessions.disposeBrain(this.sessionId, { kind: 'brain', jobId: this.jobId })
    await purgeLearningRoot(this.root, this.jobId, this.nonce)
  }
  dispose(): Promise<void> {
    this.disposed = true
    this.cleanup ??= Promise.resolve()
      .then(() => this.cleanupOwned())
      .catch((error: unknown) => {
        this.cleanup = undefined
        throw error
      })
    this.cancel()
    return this.cleanup
  }
  private async cleanupOwned(): Promise<void> {
    this.unwatch()
    for (const item of this.options.registry.list()) {
      if (item.workspacePath !== join(this.root, 'cwd')) continue
      const live = this.options.registry.get(item.sessionId)
      if (live?.owner?.jobId !== this.jobId)
        throw new Error('Learning cleanup live ownership mismatch')
      await this.options.sessions.disposeBrain(item.sessionId, { kind: 'brain', jobId: this.jobId })
    }
    await this.disposeLate()
  }
}

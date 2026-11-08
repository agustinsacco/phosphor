import { join } from 'node:path'
import type {
  BrainLearningRequest,
  BrainLearningResult,
  BrainLearningUsage,
} from '@phosphor/shared/brain-learning'
import type { PiEvent } from '@phosphor/shared/rpc'
import type { LearningExecutionProfile } from '@phosphor/session-runtime/pi/learning-execution-profile'
import type { LearningHostOptions, LearningCarrierPreview } from './learning-host'
import {
  purgeLearningRoot,
  readLearningControl,
  writeLearningControl,
} from './learning-carrier-files'
import { markLearningWriter } from './learning-carrier-recovery'
import { commandLearningCarrier, verifyLearningCommand } from './learning-carrier-transport'
import { abortable } from './processor-wait'
import { learningFailureUsage } from './learning-usage'

export class OwnedLearningCarrier {
  private readonly controller = new AbortController()
  private controlWrite: Promise<void> | undefined
  private startup: Promise<void> | undefined
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
    await this.options.paths.withSessionPath(this.root, () =>
      markLearningWriter(this.root, this.jobId, this.nonce, 'possibly-running'),
    )
    signal.throwIfAborted()
    const creation = this.options.sessions.create({ workspacePath: profile.cwd }, undefined, {
      learning: profile,
      signal,
    })
    const tracked = creation.then(async (info) => {
      this.sessionId = info.sessionId
      if (this.disposed || signal.aborted) {
        await this.stopSession(info.sessionId)
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
    this.startup = tracked
    await abortable(tracked, signal)
  }
  async preflight(signal: AbortSignal): Promise<LearningCarrierPreview> {
    const client = this.live().client
    await verifyLearningCommand(client, this.options.extensionPath, signal)
    await this.operation('prepare', signal)
    const preview = await readLearningControl<LearningCarrierPreview>(
      join(this.root, 'prepare-result.json'),
    )
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
    preview: LearningCarrierPreview,
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
    let usage: BrainLearningUsage | null = null
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
      this.controlWrite = writeLearningControl(join(this.root, 'request.json'), {
        request,
        authIdentityFence: preview.authIdentityFence,
      })
      await this.controlWrite
      deadline.throwIfAborted()
      await abortable(this.operation('run', deadline), deadline)
      const result = await readLearningControl<BrainLearningResult>(
        join(this.root, 'run-result.json'),
      )
      usage = learningFailureUsage({ learningUsage: result.usage })
      deadline.throwIfAborted()
      if (
        result.jobId !== this.jobId ||
        JSON.stringify(result.binding) !== JSON.stringify(preview.binding) ||
        result.checkpoint?.projectionDigest !== preview.checkpoint.projectionDigest
      )
        throw new Error('Learning result identity changed')
      return result
    } catch (error) {
      usage = learningFailureUsage(error) ?? usage
      throw error
    } finally {
      signal.removeEventListener('abort', stop)
      await this.disposeWithUsage(usage)
    }
  }
  private async disposeWithUsage(usage: BrainLearningUsage | null): Promise<void> {
    try {
      await this.dispose()
    } catch (error) {
      if (!usage) throw error
      throw Object.assign(
        new Error(error instanceof Error ? error.message : 'Learning cleanup failed', {
          cause: error,
        }),
        { learningUsage: usage },
      )
    }
  }
  private async stopSession(id: string): Promise<void> {
    const live = this.options.registry.get(id)
    if (live && (live.owner?.jobId !== this.jobId || live.workspacePath !== join(this.root, 'cwd')))
      throw new Error('Learning cleanup live ownership mismatch')
    await this.options.sessions.disposeBrain(id, { kind: 'brain', jobId: this.jobId })
    if (
      this.options.registry.get(id) ||
      this.options.registry.list().some((item) => item.sessionId === id)
    )
      throw new Error('Learning writer disposal is not confirmed; copied input retained')
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
  private async stopRegistered(): Promise<void> {
    for (const item of this.options.registry.list()) {
      if (item.workspacePath === join(this.root, 'cwd')) await this.stopSession(item.sessionId)
    }
  }
  private async cleanupOwned(): Promise<void> {
    this.unwatch()
    await this.options.paths.withSessionPath(this.root, async () => {
      await this.stopRegistered()
      // A late startup must settle before recording stopped: no future writer may be reachable.
      await this.startup?.catch(() => undefined)
      await this.controlWrite?.catch(() => undefined)
      await this.stopRegistered()
      if (this.sessionId) await this.stopSession(this.sessionId)
      await markLearningWriter(this.root, this.jobId, this.nonce, 'stopped')
      await purgeLearningRoot(this.root, this.jobId, this.nonce)
    })
  }
}

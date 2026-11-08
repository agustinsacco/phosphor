import { dirname, join } from 'node:path'
import type { BrainLearningRequest, BrainLearningSource } from '@phosphor/shared/brain-learning'
import { runBrainLearning } from './brain-learning'
import {
  projectLearningContext,
  learningSuffix,
  type BrainLearningPort,
  type LearningMessage,
} from './brain-learning-context'
import {
  prepareLearningAuth,
  type LearningBoundRegistry,
  type LearningSelectedModel,
} from './brain-learning-carrier-auth'
import {
  readCarrierFile,
  writeCarrierFile,
  LEARNING_CONTROL_LIMIT,
} from './brain-learning-carrier-files'
import type { LearningPiSdk } from './brain-learning-carrier-sdk'

export interface LearningCarrierControl {
  version: 1
  jobId: string
  nonce: string
  snapshotPath: string
  source: BrainLearningSource
  selected: LearningSelectedModel
}
export interface LearningCarrierContext {
  model?: { provider: string; id: string }
  modelRegistry: LearningBoundRegistry
  thinkingLevel?: string
  isIdle(): boolean
  hasPendingMessages(): boolean
  sessionManager: { getBranch(): unknown[] }
  ui: { setStatus(key: string, text: string): void }
}
function fits(
  messages: LearningMessage[],
  maxOutputTokens: number,
  contextWindow: number,
): boolean {
  // Conservative byte bound; refuse binary/unknown blocks, never clip or re-compact.
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      if (typeof message.content !== 'string') return false
      continue
    }
    if (
      message.content.some(
        (block: { type?: string }) =>
          !['text', 'thinking', 'toolCall'].includes(String(block?.type)),
      )
    )
      return false
  }
  return Buffer.byteLength(JSON.stringify(messages)) * 4 + maxOutputTokens <= contextWindow
}
export async function learningCarrierPort(
  control: LearningCarrierControl,
  ctx: LearningCarrierContext,
  sdk: LearningPiSdk,
  signal: AbortSignal,
  pin?: BrainLearningRequest['binding'] & { authIdentityFence: string },
) {
  if (
    !ctx.isIdle() ||
    ctx.hasPendingMessages() ||
    ctx.model?.provider !== control.selected.provider ||
    ctx.model.id !== control.selected.modelId ||
    ctx.thinkingLevel !== control.selected.thinkingLevel
  )
    throw new Error('Learning control session model/state changed')
  const text = await readCarrierFile(control.snapshotPath, 64 * 1024 * 1024)
  if (!text.endsWith('\n')) throw new Error('Torn learning snapshot')
  const rows = text
    .slice(0, -1)
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const header = rows.shift(),
    owner = rows.pop()
  if (
    header?.type !== 'session' ||
    header.version !== 3 ||
    owner?.type !== 'custom' ||
    owner.customType !== 'phosphor-brain-owner' ||
    (owner.data as { jobId?: string; kind?: string })?.jobId !== control.jobId ||
    (owner.data as { kind?: string }).kind !== 'brain' ||
    rows.some((entry) => entry.customType === 'phosphor-brain-owner')
  )
    throw new Error('Learning private snapshot ownership mismatch')
  const auth = await prepareLearningAuth(ctx.modelRegistry, { ...control.selected, ...pin }, signal)
  const port: BrainLearningPort = {
    binding: auth.binding,
    model: auth.model,
    mode: auth.mode,
    getActiveTools: () => [],
    sessionManager: {
      getLeafId: () => control.source.selectedLeafId,
      getBranch: () => rows,
      buildSessionProjection: () => sdk.buildSessionProjection(rows, control.source.selectedLeafId),
    },
    convertToLlm: sdk.convertToLlm,
    contextFits: (messages, max) => fits(messages, max, auth.model.contextWindow),
    modelRegistry: { streamSimple: auth.streamSimple },
  }
  return { port, authIdentityFence: auth.authIdentityFence, maxOutputTokens: auth.maxOutputTokens }
}
function checkedProjection(
  request: BrainLearningRequest,
  port: BrainLearningPort,
  maxOutputTokens: number,
) {
  const projection = projectLearningContext(request, port)
  if (
    Buffer.byteLength(JSON.stringify(projection)) > LEARNING_CONTROL_LIMIT ||
    !port.contextFits(
      [
        ...projection.messages,
        {
          role: 'user',
          content: learningSuffix(projection.evidence),
          timestamp: request.suffixTimestamp,
        },
      ],
      maxOutputTokens,
    )
  )
    throw new Error('Learning context exceeds its bounded supported size')
  return projection
}
export function createLearningCarrierOperation(
  control: LearningCarrierControl,
  root: string,
  sdk: LearningPiSdk,
  signal: AbortSignal,
  assertTools: () => void,
) {
  let prepared:
    { projection: ReturnType<typeof projectLearningContext>; authIdentityFence: string } | undefined
  let used = false
  return async (operation: 'prepare' | 'run', ctx: LearningCarrierContext): Promise<void> => {
    signal.throwIfAborted()
    assertTools()
    const envelope =
      operation === 'run'
        ? (JSON.parse(await readCarrierFile(join(root, 'request.json'))) as {
            request: BrainLearningRequest
            authIdentityFence: string
          })
        : undefined
    const request = envelope?.request
    if (
      operation === 'run' &&
      (used ||
        !prepared ||
        envelope?.authIdentityFence !== prepared.authIdentityFence ||
        request?.jobId !== control.jobId ||
        JSON.stringify(request.source) !== JSON.stringify(control.source))
    )
      throw new Error('Learning carrier run requires one prepared matching job')
    if (operation === 'run') used = true
    const { port, authIdentityFence, maxOutputTokens } = await learningCarrierPort(
      control,
      ctx,
      sdk,
      signal,
      request && envelope
        ? { ...request.binding, authIdentityFence: envelope.authIdentityFence }
        : undefined,
    )
    const previewRequest: BrainLearningRequest = request ?? {
      version: 1,
      jobId: control.jobId,
      source: control.source,
      binding: port.binding,
      alreadyCovered: [],
      suffixTimestamp: 0,
      maxOutputTokens,
      deadlineMs: 120000,
    }
    const projection = checkedProjection(previewRequest, port, maxOutputTokens)
    assertTools()
    signal.throwIfAborted()
    if (operation === 'prepare') {
      if (prepared) throw new Error('Learning carrier already prepared')
      prepared = { projection, authIdentityFence }
      await writeCarrierFile(join(root, 'prepare-result.json'), {
        binding: port.binding,
        authIdentityFence,
        checkpoint: projection.checkpoint,
        evidence: projection.evidence,
        maxOutputTokens,
      })
    } else {
      if (
        projection.checkpoint.projectionDigest !==
          prepared!.projection.checkpoint.projectionDigest ||
        !request ||
        request.maxOutputTokens > maxOutputTokens
      )
        throw new Error('Learning projection or output budget changed')
      const result = await runBrainLearning(request, port, signal)
      signal.throwIfAborted()
      assertTools()
      await writeCarrierFile(join(root, 'run-result.json'), result)
    }
  }
}
export function validateCarrierControl(
  control: LearningCarrierControl,
  controlFile: string,
  jobId: string,
  nonce: string,
): void {
  if (
    control.version !== 1 ||
    control.jobId !== jobId ||
    control.nonce !== nonce ||
    dirname(control.snapshotPath) !== dirname(controlFile) ||
    !control.source ||
    !control.selected
  )
    throw new Error('Learning carrier control ownership mismatch')
}

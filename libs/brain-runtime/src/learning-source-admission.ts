import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { appendFile, lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute } from 'node:path'
import type { BrainLearningTarget } from '@phosphor/shared/brain-learning-jobs'
import type { Model, ThinkingLevel } from '@phosphor/shared/rpc'
import type { SessionRegistry, LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { SessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { assertNotBrainSource } from '@phosphor/session-runtime/pi/brain-session-admission'
import { laneAuthority } from './authority'
import {
  freezeLearningSource,
  writeLearningSnapshot,
  type FrozenLearningSource,
  type LearningSourceState,
} from './learning-source'

export interface LearningSourceSelection {
  provider: string
  modelId: string
  api?: string
  thinkingLevel: ThinkingLevel
  /** Current host assignment, never a reconstructed historical billing identity. */
  accountId?: string
}
export interface LearningSourceAdmissionRuntime {
  registry: Pick<SessionRegistry, 'list' | 'get'>
  paths: SessionPathRuntime
  sessionsRoot: string
}
const MAX_SOURCE_BYTES = 64 * 1024 * 1024
/** Strict bounded file read, never readline or the permissive ordinary transcript parser. */
export async function readLearningFile(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > maxBytes)
      throw new Error('Unsafe or oversized learning file')
    const buffer = Buffer.alloc(before.size + 1)
    let total = 0
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total)
      if (!bytesRead) break
      total += bytesRead
    }
    const after = await file.stat()
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error('Learning file changed while reading')
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total))
  } finally {
    await file.close()
  }
}
function rows(frozen: FrozenLearningSource): Record<string, unknown>[] {
  return frozen.lines.map((line) => JSON.parse(line) as Record<string, unknown>)
}
function completed(frozen: FrozenLearningSource): void {
  const pending = new Set<string>()
  let lastRole: unknown, lastStop: unknown
  for (const entry of rows(frozen)) {
    if (entry.type !== 'message') continue
    const message = entry.message as Record<string, unknown>
    if (!message || typeof message.role !== 'string')
      throw new Error('Unverifiable learning message')
    if (message.role === 'assistant') {
      if (!Array.isArray(message.content)) throw new Error('Unverifiable completed assistant')
      for (const block of message.content as Array<Record<string, unknown>>) {
        if (block.type !== 'toolCall') continue
        if (typeof block.id !== 'string' || pending.has(block.id))
          throw new Error('Unverifiable source tools')
        pending.add(block.id)
      }
      lastRole = message.role
      lastStop = message.stopReason
    } else if (message.role === 'toolResult') {
      if (typeof message.toolCallId !== 'string' || !pending.delete(message.toolCallId))
        throw new Error('Unverifiable source tool result')
      lastRole = message.role
    } else if (message.role === 'user') lastRole = message.role
  }
  if (pending.size || lastRole !== 'assistant' || lastStop !== 'stop')
    throw new Error('Learning requires a settled completed source assistant')
}
export function learningSourceSelection(frozen: FrozenLearningSource): LearningSourceSelection {
  let provider: unknown, modelId: unknown, api: unknown, thinking: unknown
  for (const entry of rows(frozen)) {
    if (entry.type === 'model_change') {
      provider = entry.provider
      modelId = entry.modelId
      api = undefined
    }
    if (entry.type === 'thinking_level_change') thinking = entry.thinkingLevel
    const message =
      entry.type === 'message' ? (entry.message as Record<string, unknown>) : undefined
    if (message?.role === 'assistant') {
      provider = message.provider
      modelId = message.model
      api = message.api
    }
  }
  if (
    typeof provider !== 'string' ||
    !provider ||
    typeof modelId !== 'string' ||
    !modelId ||
    !['off', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(String(thinking))
  )
    throw new Error('Learning source model/thinking selection is unverifiable')
  return {
    provider,
    modelId,
    ...(typeof api === 'string' && api ? { api } : {}),
    thinkingLevel: thinking as ThinkingLevel,
  }
}
export async function inspectLearningLiveSource(
  live: LiveSession,
  path: string,
  frozen: FrozenLearningSource,
): Promise<LearningSourceState & { model: Model }> {
  if (live.owner || live.startupComplete !== true || !live.client.alive)
    throw new Error('Learning source is private or starting')
  const state = await live.client.request({ type: 'get_state' })
  const entries = await live.client.request({ type: 'get_entries' })
  if (
    !state.success ||
    !state.data ||
    !entries.success ||
    !entries.data ||
    live.client.activity.busy ||
    state.data.isStreaming !== false ||
    state.data.isCompacting !== false ||
    state.data.pendingMessageCount !== 0 ||
    state.data.sessionId !== frozen.source.sessionId ||
    !state.data.sessionFile ||
    sessionPathKey(state.data.sessionFile) !== path ||
    entries.data.leafId !== frozen.source.selectedLeafId
  )
    throw new Error('Learning source is busy or identity is unverifiable')
  const selection = learningSourceSelection(frozen)
  if (
    state.data.model?.provider !== selection.provider ||
    state.data.model.id !== selection.modelId ||
    state.data.thinkingLevel !== selection.thinkingLevel
  )
    throw new Error('Learning source live model selection changed')
  const byId = new Map(
    entries.data.entries.map((raw) => {
      const entry = raw as Record<string, unknown>
      return [entry.id, entry]
    }),
  )
  if (rows(frozen).some((entry) => JSON.stringify(byId.get(entry.id)) !== JSON.stringify(entry)))
    throw new Error('Learning source branch changed')
  return {
    model: state.data.model,
    sessionId: frozen.source.sessionId,
    selectedLeafId: frozen.source.selectedLeafId,
    settled: true,
    fence: createHash('sha256')
      .update(JSON.stringify([state.data, entries.data, live.client.activity.settledRevision]))
      .digest('hex'),
  }
}
async function selectedSource(text: string, workspace: string, path: string) {
  const raw = text
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
  const header = raw[0],
    leaf = raw.at(-1)
  if (
    !header ||
    typeof header.id !== 'string' ||
    !/^[a-f0-9-]{36}$/i.test(header.id) ||
    !basename(path).endsWith(`_${header.id}.jsonl`) ||
    typeof header.cwd !== 'string' ||
    (await realpath(header.cwd)) !== workspace ||
    typeof leaf?.id !== 'string'
  )
    throw new Error('Learning source identity is unverifiable')
  const selection = { sessionId: header.id, selectedLeafId: leaf.id }
  const initial = freezeLearningSource(text, selection)
  if (rows(initial).some((entry) => entry.customType === 'pi.virtual-model-state'))
    throw new Error('Learning refuses virtual source routing')
  return { selection, initial }
}
/** Authority is the canonical workspace session directory AND source identity, never a header alone.
 * The lock is owner-process local: another external pi writer is not transactionally excluded.
 */
export async function admitLearningSource(
  runtime: LearningSourceAdmissionRuntime,
  target: BrainLearningTarget,
  snapshotPath: string,
  jobId: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  if (!isAbsolute(target.sessionPath) || !isAbsolute(target.workspacePath))
    throw new Error('Invalid learning source path')
  const workspace = await realpath(target.workspacePath),
    path = await realpath(target.sessionPath)
  if (
    target.sessionPath !== path ||
    (await lstat(target.sessionPath)).isSymbolicLink() ||
    dirname(path) !== (await realpath(sessionDirForCwd(workspace, runtime.sessionsRoot)))
  )
    throw new Error('Learning source is not an allowed workspace session')
  const authority = await laneAuthority(workspace)
  return runtime.paths.withSessionPath(path, async () => {
    signal.throwIfAborted()
    await assertNotBrainSource(path, workspace, runtime.registry)
    const text = await readLearningFile(path, MAX_SOURCE_BYTES)
    const { selection, initial } = await selectedSource(text, workspace, path)
    completed(initial)
    const matching = runtime.registry
      .list()
      .filter((live) => live.diskPath && sessionPathKey(live.diskPath) === path)
    if (matching.length > 1) throw new Error('Learning source has conflicting live owners')
    const inspect = async (): Promise<LearningSourceState> => {
      signal.throwIfAborted()
      const current = runtime.registry
        .list()
        .filter((live) => live.diskPath && sessionPathKey(live.diskPath) === path)
      if (
        JSON.stringify(current.map((live) => live.sessionId)) !==
        JSON.stringify(matching.map((live) => live.sessionId))
      )
        throw new Error('Learning source owner changed')
      if (matching.length) {
        const live = runtime.registry.get(matching[0]!.sessionId)
        if (!live) throw new Error('Learning source owner changed')
        return inspectLearningLiveSource(live, path, initial)
      }
      return { ...selection, settled: true, fence: initial.source.sourceDigest }
    }
    const frozen = await writeLearningSnapshot({
      sourcePath: path,
      snapshotPath,
      selection,
      inspect,
    })
    // A disconnected metadata root hides the private file without re-chaining model-visible ancestry.
    await appendFile(
      snapshotPath,
      JSON.stringify({
        type: 'custom',
        id: randomUUID(),
        parentId: null,
        customType: 'phosphor-brain-owner',
        data: { version: 1, kind: 'brain', jobId },
      }) + '\n',
    )
    signal.throwIfAborted()
    return {
      scope: authority.scope,
      branch: authority.branch,
      frozen,
      selection: learningSourceSelection(frozen),
      liveSessionId: matching[0]?.sessionId,
    }
  })
}

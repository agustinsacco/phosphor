import { realpath } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import type { BrainLearningBinding, BrainLearningSource } from '@phosphor/shared/brain-learning'
import type { BrainLearningTarget } from '@phosphor/shared/brain-learning-jobs'
import type { Model, RpcAuthBindingStatus } from '@phosphor/shared/rpc'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import {
  inspectLearningLiveSource,
  learningSourceSelection,
  readLearningFile,
  type LearningSourceAdmissionRuntime,
  type LearningSourceSelection,
} from './learning-source-admission'
import { freezeLearningSource } from './learning-source'
import { abortable } from './processor-wait'

export interface LearningSourceBinding {
  binding: BrainLearningBinding
  authIdentityFence: string
  sessionId: string
  selectedLeafId: string
  settled: true
}
const nativeApis: Readonly<Record<string, string>> = {
  openai: 'openai-responses',
  'openai-codex': 'openai-codex-responses',
  anthropic: 'anthropic-messages',
}
function receiptBinding(
  receipt: RpcAuthBindingStatus | undefined,
  selection: LearningSourceSelection,
  model: Model,
  source: BrainLearningSource,
): LearningSourceBinding {
  if (!receipt || receipt.available !== true)
    throw new Error('Learning source get_auth_binding is unavailable or changed')
  const binding = receipt.binding
  if (
    receipt.sourceSessionId !== source.sessionId ||
    !binding ||
    binding.provider !== selection.provider ||
    binding.modelId !== selection.modelId ||
    binding.api !== model.api ||
    (selection.api !== undefined && binding.api !== selection.api) ||
    binding.endpoint !== model.baseUrl ||
    !['oauth', 'api-key'].includes(binding.authMode) ||
    (selection.accountId !== undefined && binding.accountId !== selection.accountId) ||
    typeof binding.accountId !== 'string' ||
    !/^[\w.:-]{1,256}$/.test(binding.accountId) ||
    typeof receipt.authIdentityFence !== 'string' ||
    !/^[\w.:-]{1,256}$/.test(receipt.authIdentityFence) ||
    typeof binding.endpoint !== 'string' ||
    binding.endpoint.length > 4096
  )
    throw new Error('Learning source get_auth_binding identity is unverifiable')
  let endpoint: URL
  try {
    endpoint = new URL(binding.endpoint)
  } catch {
    throw new Error('Learning source endpoint is unverifiable')
  }
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error('Learning source endpoint is unqualified')
  return {
    binding: {
      provider: binding.provider,
      modelId: binding.modelId,
      api: binding.api,
      endpoint: binding.endpoint,
      authMode: binding.authMode,
      accountId: binding.accountId,
      thinkingLevel: selection.thinkingLevel,
    },
    authIdentityFence: receipt.authIdentityFence,
    sessionId: source.sessionId,
    selectedLeafId: source.selectedLeafId,
    settled: true,
  }
}
/** Metadata only, under the same lock domain as admission/resume/delete. The receipt
 * describes current successful process use, not the billing identity of an old branch.
 */
export async function readLearningSourceBinding(
  runtime: LearningSourceAdmissionRuntime,
  target: BrainLearningTarget,
  liveSessionId: string,
  source: BrainLearningSource,
  signal: AbortSignal,
): Promise<LearningSourceBinding> {
  signal.throwIfAborted()
  return runtime.paths.withSessionPath(target.sessionPath, async () => {
    if ((await realpath(target.sessionPath)) !== target.sessionPath)
      throw new Error('Learning source path changed')
    const path = target.sessionPath,
      live = runtime.registry.get(liveSessionId)
    if (!live) throw new Error('Learning source owner changed')
    const assertOwner = () => {
      signal.throwIfAborted()
      const owners = runtime.registry
        .list()
        .filter((item) => item.diskPath && sessionPathKey(item.diskPath) === path)
      if (
        owners.length !== 1 ||
        owners[0]!.sessionId !== liveSessionId ||
        runtime.registry.get(liveSessionId) !== live ||
        live.sessionId !== liveSessionId ||
        sessionPathKey(live.workspacePath) !== sessionPathKey(target.workspacePath) ||
        live.owner ||
        live.startupComplete !== true ||
        !live.client.alive
      )
        throw new Error('Learning source owner changed or is unavailable')
    }
    const observe = async () => {
      assertOwner()
      const revision = live.client.activity.settledRevision
      if (revision === undefined) throw new Error('Learning source is not settled')
      const frozen = freezeLearningSource(await readLearningFile(path, 64 * 1024 * 1024), source)
      if (!isDeepStrictEqual(frozen.source, source))
        throw new Error('Learning source bytes changed')
      const state = await abortable(inspectLearningLiveSource(live, path, frozen), signal)
      assertOwner()
      if (live.client.activity.settledRevision !== revision)
        throw new Error('Learning source revision changed')
      return { frozen, state, revision }
    }
    const first = await observe(),
      selection = learningSourceSelection(first.frozen)
    if (!nativeApis[selection.provider] || first.state.model.api !== nativeApis[selection.provider])
      throw new Error(
        'Learning source native provider/API is unqualified; CLI identity hook is unavailable',
      )
    let response
    try {
      response = await abortable(live.client.request({ type: 'get_auth_binding' }), signal)
    } catch {
      signal.throwIfAborted()
      throw new Error(
        'Learning source metadata-only get_auth_binding is unavailable; upgraded pi required',
      )
    }
    if (response?.success !== true)
      throw new Error('Learning source get_auth_binding is unavailable')
    const binding = receiptBinding(response.data, selection, first.state.model, source)
    const last = await observe()
    if (first.state.fence !== last.state.fence)
      throw new Error('Learning source changed during get_auth_binding')
    // No await between this final read and the owner/revision recheck.
    const final = freezeLearningSource(await readLearningFile(path, 64 * 1024 * 1024), source)
    assertOwner()
    if (
      !isDeepStrictEqual(final.source, source) ||
      live.client.activity.settledRevision !== last.revision
    )
      throw new Error('Learning source changed during get_auth_binding')
    return binding
  })
}

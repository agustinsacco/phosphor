import type { BrainLearningBinding } from '@phosphor/shared/brain-learning'
import type { ThinkingLevel } from '@phosphor/shared/rpc'
import { compareVersions } from '@phosphor/shared/version'
import type { BrainLearningPort } from './brain-learning-context'

export interface LearningSelectedModel {
  provider: string
  modelId: string
  api?: string
  thinkingLevel: ThinkingLevel
  accountId?: string
  endpoint?: string
  authMode?: BrainLearningBinding['authMode']
  claudeVersion?: string
  authIdentityFence?: string
}
export interface LearningActualModel {
  provider: string
  id: string
  api: string
  baseUrl: string
  contextWindow: number
  maxTokens: number
}
type Stream = BrainLearningPort['modelRegistry']['streamSimple']
/** SDK-neutral pi prerequisite. No secret-returning getter or caller-supplied credentials. */
export interface LearningBoundRequest {
  binding: Omit<BrainLearningBinding, 'thinkingLevel'>
  authIdentityFence: string
  streamSimple(context: Parameters<Stream>[1], options: Parameters<Stream>[2]): ReturnType<Stream>
}
export interface LearningBoundRegistry {
  boundRequestVersion?: number
  find(provider: string, id: string): LearningActualModel | undefined
  prepareBoundRequest?(
    model: LearningActualModel,
    options: {
      expected: Omit<LearningSelectedModel, 'claudeVersion' | 'thinkingLevel'>
      signal: AbortSignal
      routePolicy?: 'claude-single-response'
      allowVirtual: false
      allowCustom: boolean
      allowFallback: false
    },
  ): Promise<LearningBoundRequest>
}
const PREREQUISITE =
  'Learning requires pi >=1.4 with ModelRegistry.boundRequestVersion === 1 and prepareBoundRequest: metadata-only current-slot discovery, atomically fenced provider-owned auth/refresh, no fallback or virtual/custom routing.'
function checkBinding(
  binding: LearningBoundRequest['binding'],
  selected: LearningSelectedModel,
  model: LearningActualModel,
): void {
  for (const key of ['provider', 'modelId', 'api', 'endpoint', 'accountId', 'authMode'] as const) {
    if (
      typeof binding[key] !== 'string' ||
      !binding[key] ||
      binding[key].length > 4096 ||
      (selected[key] !== undefined && selected[key] !== binding[key])
    )
      throw new Error('Learning current-slot binding changed or is unverifiable')
  }
  const endpoint = new URL(binding.endpoint)
  if (
    !['https:', 'http:'].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    binding.provider !== model.provider ||
    binding.modelId !== model.id ||
    binding.api !== model.api ||
    binding.endpoint !== model.baseUrl
  )
    throw new Error('Learning route/endpoint changed or is unqualified')
}
function oneShotLearningStream(
  bound: LearningBoundRequest,
  model: LearningActualModel,
  selected: LearningSelectedModel,
  cli: boolean,
): Stream {
  let used = false
  return (actual, context, options) => {
    if (
      used ||
      actual !== model ||
      options.maxRetries !== 0 ||
      options.maxTokens > Math.min(model.maxTokens, 32768) ||
      options.reasoning !== (selected.thinkingLevel === 'off' ? undefined : selected.thinkingLevel)
    )
      throw new Error('Learning bound request is one-shot and forbids model/options fallback')
    if (
      Object.keys(options).some(
        (key) => !['signal', 'maxRetries', 'maxTokens', 'reasoning', 'metadata'].includes(key),
      )
    )
      throw new Error('Learning forbids credential/request overrides')
    if (cli ? options.metadata?.piSingleResponse !== 1 : options.metadata !== undefined)
      throw new Error('Learning requires the qualified one-shot provider option')
    used = true
    // The trusted provider-owned route injects its private one-shot marker; core
    // deliberately rejects arbitrary metadata, including this validated marker.
    const { metadata: _metadata, ...coreOptions } = options
    return bound.streamSimple(context, coreOptions)
  }
}
/** Preflight does not resolve auth values, refresh, execute shell commands, or generate. */
export async function prepareLearningAuth(
  registry: LearningBoundRegistry,
  selected: LearningSelectedModel,
  signal: AbortSignal,
) {
  signal.throwIfAborted()
  const cli = selected.provider === 'pi-claude-cli'
  if (cli && !selected.accountId)
    throw new Error('Learning Claude requires an explicit read-only host account assignment')
  if (
    cli &&
    (!selected.claudeVersion ||
      !/^\d+\.\d+\.\d+$/.test(selected.claudeVersion) ||
      compareVersions(selected.claudeVersion, '0.11.0') < 0)
  )
    throw new Error(
      'Learning Claude requires the separately qualified pi-claude-cli >=0.11.0 piSingleResponse:1 provider',
    )
  if (registry.boundRequestVersion !== 1 || typeof registry.prepareBoundRequest !== 'function')
    throw new Error(PREREQUISITE)
  const model = registry.find(selected.provider, selected.modelId)
  if (
    !model ||
    model.api === 'pi-virtual' ||
    model.provider !== selected.provider ||
    model.id !== selected.modelId ||
    (selected.api && model.api !== selected.api) ||
    !Number.isSafeInteger(model.maxTokens) ||
    model.maxTokens < 1 ||
    !Number.isSafeInteger(model.contextWindow) ||
    model.contextWindow < 1
  )
    throw new Error('Learning exact selected model is unavailable or unsupported')
  const { claudeVersion: _version, thinkingLevel: _thinking, ...expected } = selected
  const bound = await registry.prepareBoundRequest(model, {
    expected,
    signal,
    ...(cli ? { routePolicy: 'claude-single-response' as const } : {}),
    allowVirtual: false,
    allowCustom: cli,
    allowFallback: false,
  })
  signal.throwIfAborted()
  checkBinding(bound.binding, selected, model)
  if (
    typeof bound.authIdentityFence !== 'string' ||
    !/^[\w.:-]{1,256}$/.test(bound.authIdentityFence) ||
    (selected.authIdentityFence && selected.authIdentityFence !== bound.authIdentityFence)
  )
    throw new Error('Learning auth identity changed or cannot be fenced')
  if (
    cli ? bound.binding.authMode !== 'cli' : !['oauth', 'api-key'].includes(bound.binding.authMode)
  )
    throw new Error('Learning selected auth method is unqualified')
  const binding: BrainLearningBinding = {
    provider: bound.binding.provider,
    modelId: bound.binding.modelId,
    api: bound.binding.api,
    endpoint: bound.binding.endpoint,
    accountId: bound.binding.accountId,
    authMode: bound.binding.authMode,
    thinkingLevel: selected.thinkingLevel,
  }
  const streamSimple = oneShotLearningStream(bound, model, selected, cli)
  return {
    binding,
    authIdentityFence: bound.authIdentityFence,
    model,
    streamSimple,
    maxOutputTokens: Math.min(model.maxTokens, 32768),
    mode: cli ? ('claude-single-response' as const) : ('native' as const),
  }
}

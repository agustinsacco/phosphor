import type { BrainLearningRequest, BrainLearningResult } from '@phosphor/shared/brain-learning'
import {
  learningSuffix,
  projectLearningContext,
  type BrainLearningPort,
} from './brain-learning-context'
import { learningResponse, resolveLearningOutcome } from './brain-learning-result'

export type { BrainLearningPort } from './brain-learning-context'
function admit(request: BrainLearningRequest, port: BrainLearningPort): void {
  if (
    request.version !== 1 ||
    !request.jobId ||
    !Number.isSafeInteger(request.deadlineMs) ||
    request.deadlineMs < 1 ||
    request.deadlineMs > 120_000 ||
    !Number.isSafeInteger(request.maxOutputTokens) ||
    request.maxOutputTokens < 1 ||
    request.maxOutputTokens > 32_768 ||
    !Number.isSafeInteger(request.suffixTimestamp)
  )
    throw new Error('Invalid learning request bounds')
  for (const key of [
    'provider',
    'modelId',
    'api',
    'accountId',
    'authMode',
    'thinkingLevel',
    'endpoint',
  ] as const)
    if (
      typeof request.binding[key] !== 'string' ||
      !request.binding[key] ||
      request.binding[key] !== port.binding[key]
    )
      throw new Error('Learning model/account binding mismatch')
  if (
    !request.binding.accountId ||
    !request.binding.endpoint ||
    port.model.provider !== request.binding.provider ||
    port.model.id !== request.binding.modelId ||
    port.model.api !== request.binding.api
  )
    throw new Error('Learning selected model is unavailable')
  if (port.getActiveTools().length) throw new Error('Learning requires no active executable tools')
  if (port.mode === 'claude-single-response') {
    if (request.binding.provider !== 'pi-claude-cli' || request.binding.authMode !== 'cli')
      throw new Error('Learning Claude capability mismatch')
  } else if (
    port.mode !== 'native' ||
    request.binding.provider === 'pi-claude-cli' ||
    !['oauth', 'api-key'].includes(request.binding.authMode)
  )
    throw new Error('Unsupported learning provider capability')
}
/** Trusted pi-side operation, deliberately not an agent prompt or a model-callable tool.
 * The host injects an attested selected registry/auth binding and pi's own projection/conversion.
 * It gates custom provider support and Claude >=0.11.0 before constructing this port.
 * No scheduler, tool executor, fallback, retry, compaction or follow-up is reachable here.
 */
export async function runBrainLearning(
  input: BrainLearningRequest,
  port: BrainLearningPort,
  signal: AbortSignal,
): Promise<BrainLearningResult> {
  signal.throwIfAborted()
  // Freeze job identity as well as content before any injected callback or asynchronous work.
  const request = structuredClone(input)
  admit(request, port)
  const { messages, evidence, checkpoint } = projectLearningContext(request, port)
  if (!evidence.some((item) => item.eligible))
    throw new Error('Learning source has no new eligible projected text')
  const context = {
    messages: structuredClone([
      ...messages,
      {
        role: 'user',
        content: learningSuffix(evidence),
        timestamp: request.suffixTimestamp,
      },
    ]),
  }
  if (!port.contextFits(structuredClone(context.messages), request.maxOutputTokens))
    throw new Error('Learning context is oversized or unsupported')
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(
    () => controller.abort(new Error('Learning deadline exceeded')),
    request.deadlineMs,
  )
  let detach = () => {}
  try {
    signal.throwIfAborted()
    const cancelled = new Promise<never>((_resolve, reject) => {
      const listener = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', listener, { once: true })
      detach = () => controller.signal.removeEventListener('abort', listener)
    })
    const stream = port.modelRegistry.streamSimple(port.model, context, {
      signal: controller.signal,
      maxRetries: 0,
      maxTokens: request.maxOutputTokens,
      reasoning:
        request.binding.thinkingLevel === 'off' ? undefined : request.binding.thinkingLevel,
      ...(port.mode === 'claude-single-response'
        ? { metadata: { piSingleResponse: 1 as const } }
        : {}),
    })
    const raw = await Promise.race([stream.result(), cancelled])
    controller.signal.throwIfAborted()
    const response = learningResponse(raw)
    return {
      version: 1,
      jobId: request.jobId,
      binding: request.binding,
      checkpoint,
      evidence,
      outcome: resolveLearningOutcome(response.text, evidence),
      usage: response.usage,
      execution: {
        logicalGenerations: 1,
        networkAttempts: null,
        serializedPrefixIdentical: false,
        cacheReuse: 'best-effort',
        history: 'pi-projected-context',
      },
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abort)
    detach()
  }
}

import type { CallErrorCode } from '@phosphor/shared/host-protocol'
import type { FeatureOutcome } from './feature'

type Phase = 'queue' | 'inspection' | 'pi startup' | 'pi reply' | 'skill read' | 'catalogue'
type Cause =
  | 'queue-full'
  | 'queue-timeout'
  | 'timeout'
  | 'spawn'
  | 'exited'
  | 'decode'
  | 'cancelled'
  | 'missing-pi'

export class FeatureFailure extends Error {
  constructor(
    readonly code: CallErrorCode,
    override readonly cause?: Cause,
    readonly phase?: Phase,
    readonly budgetMs?: number,
  ) {
    super(code)
  }
}

function explanation(error: FeatureFailure) {
  const seconds = Math.max(1, Math.ceil((error.budgetMs ?? 0) / 1000))
  switch (error.cause) {
    case 'queue-full':
      return 'The feature probe queue is full; try again shortly.'
    case 'queue-timeout':
      return `Feature probe timed out in the queue after ${seconds}s; try again when the current probe finishes.`
    case 'timeout':
      return `Feature probe timed out during ${error.phase ?? 'execution'} after ${seconds}s; try again shortly.`
    case 'spawn':
      return 'The pi probe child failed to start; check the configured pi executable and repository.'
    case 'exited':
      return 'The pi probe child exited before replying; check that pi can start in this repository.'
    case 'decode':
      return 'The pi probe returned a protocol error; check that pi and its extensions are up to date.'
    case 'cancelled':
      return `Feature probe cancelled during ${error.phase ?? 'execution'}.`
    case 'missing-pi':
      return 'This feature is unavailable on this binding: no usable pi executable was resolved.'
  }
  switch (error.code) {
    case 'bad-request':
      return 'Invalid feature request.'
    case 'unknown-lane':
      return 'No such lane on this machine.'
    case 'forbidden':
      return 'This feature request is not allowed on this machine.'
    case 'too-large':
      return 'Feature result exceeds its limit; narrow the request.'
    case 'unsupported':
      return 'This feature is unavailable on this binding: it is not configured here.'
    default:
      return 'Feature unavailable; check the Host log and retry.'
  }
}

export function featureError(error: unknown): Extract<FeatureOutcome, { ok: false }> {
  const failure = error instanceof FeatureFailure ? error : new FeatureFailure('internal')
  return { ok: false, error: { code: failure.code, message: explanation(failure) } }
}

/** Bound filesystem and inspection waits as well as child probes. Late errors are consumed. */
export async function withinProbe<T>(
  work: () => Promise<T>,
  deadline: number,
  phase: Phase,
  signal?: AbortSignal,
): Promise<T> {
  const remaining = deadline - performance.now()
  const cancelled = () => new FeatureFailure('internal', 'cancelled', phase)
  const expired = () => new FeatureFailure('internal', 'timeout', phase, remaining)
  if (signal?.aborted) throw cancelled()
  if (remaining <= 0) throw expired()
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(expired()), remaining)
        abort = () => reject(cancelled())
        signal?.addEventListener('abort', abort, { once: true })
      }),
      work(),
    ])
  } finally {
    clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  }
}

/**
 * `job.status` with the two answers an agent needs most: why a job failed, and
 * where a job lives. The text gains them; the data does not change.
 * Living contract: docs/agent-control.md.
 */
import { OpRefusal } from './builtins'
import type { OpHandler } from './types'

/** A job belongs to the machine that ran it. */
export const JOB_HOST_HINT =
  'A job lives on the machine that ran it: pass the same --host you started it with.'

function failure(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const { state, result } = data as { state?: unknown; result?: { text?: unknown } | null }
  if (state !== 'failed' && state !== 'interrupted') return ''
  const text = result?.text
  return typeof text === 'string' && text.length > 0 ? `\n${text}` : ''
}

/** Wraps `job.status` from `jobHandlers`; every other handler passes through. */
export function explainJobs<T extends Readonly<Record<string, OpHandler>>>(handlers: T): T {
  const status = handlers['job.status']
  if (!status) return handlers
  const explained: OpHandler = async (args, ctx) => {
    try {
      const out = await status(args, ctx)
      const reason = failure(out.data)
      return reason ? { ...out, text: `${out.text}${reason}` } : out
    } catch (error) {
      if (error instanceof OpRefusal && error.code === 'forbidden')
        throw new OpRefusal(error.code, `${error.message} ${JOB_HOST_HINT}`)
      throw error
    }
  }
  return { ...handlers, 'job.status': explained }
}

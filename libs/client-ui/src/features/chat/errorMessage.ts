/**
 * Pull the human sentence out of a provider error.
 *
 * Providers hand pi back an HTTP status and a JSON envelope, and pi forwards
 * the whole thing verbatim as `errorMessage`. The transcript then rendered a
 * wall of JSON with the one sentence that matters buried in the middle:
 *
 *   400 {"type":"error","error":{"type":"invalid_request_error","message":
 *   "Third-party apps now draw from your extra usage…"},"request_id":"req_01…"}
 *
 * This finds that sentence. It never *replaces* the raw text — ErrorBlock keeps
 * it behind a disclosure, because the type and request id are exactly what you
 * need when you report the failure to the provider.
 */

export interface ParsedError {
  /** The sentence to show. Falls back to the raw string when nothing parsed. */
  text: string
  /** HTTP status, when the message was prefixed with one. */
  status?: number
  /** Provider's machine-readable kind, e.g. `invalid_request_error`. */
  type?: string
  /** Provider's correlation id, worth keeping for support tickets. */
  requestId?: string
  /** True when `text` is a strict subset of the input — i.e. raw is worth keeping. */
  unwrapped: boolean
}

/** Keys that hold a human sentence, in the order providers tend to nest them. */
function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 4) return undefined
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value !== 'object' || value === null) return undefined

  const record = value as Record<string, unknown>
  // `message` first: on an envelope like {error:{message}}, recursing into
  // `error` finds the same string, but on {message, error:{…}} the top-level
  // one is the summary and the nested one is a detail.
  for (const key of ['message', 'error', 'detail', 'description']) {
    if (!(key in record)) continue
    const found = findMessage(record[key], depth + 1)
    if (found) return found
  }
  return undefined
}

function firstString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const found = (value as Record<string, unknown>)[key]
  return typeof found === 'string' ? found : undefined
}

/**
 * Slice out the JSON body. Providers prefix a status (`400 {…}`) and pi
 * sometimes appends its own context, so neither end is reliably the envelope —
 * take from the first `{` to the last `}` and let the parse decide.
 */
function jsonBody(raw: string): unknown {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(raw.slice(start, end + 1))
  } catch {
    return undefined
  }
}

export function parseErrorMessage(raw: string | undefined): ParsedError {
  const input = raw?.trim() ?? ''
  if (!input) return { text: 'The model request failed.', unwrapped: false }

  const status = /^(\d{3})\b/.exec(input)
  const body = jsonBody(input)
  const message = findMessage(body)

  // No JSON, or JSON with no sentence in it: show what we were given. A
  // guessed summary would be worse than the raw text.
  if (!message || message.length >= input.length) {
    return { text: input, status: status ? Number(status[1]) : undefined, unwrapped: false }
  }

  const inner = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
  return {
    text: message,
    status: status ? Number(status[1]) : undefined,
    type: firstString(inner.error, 'type') ?? firstString(inner, 'type'),
    requestId: firstString(inner, 'request_id') ?? firstString(inner, 'requestId'),
    unwrapped: true,
  }
}

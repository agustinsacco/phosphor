import {
  CONTROL_ERROR_STATUS,
  parseControlError,
  type ControlErrorCode,
  type Parsed,
} from '@phosphor/shared/control-api'

export class ControlFailure extends Error {
  constructor(readonly code: ControlErrorCode | 'offline') {
    // Do not echo server messages, transport errors or response bytes.
    super(
      code === 'offline'
        ? 'The control plane could not be reached.'
        : `Control request failed (${code}).`,
    )
  }
}

function invalidResponse(response: Response): ControlFailure {
  return new ControlFailure(
    !response.ok && response.status === 429
      ? 'too-many-requests'
      : !response.ok && response.status >= 500
        ? 'unavailable'
        : 'internal',
  )
}

async function readBody(response: Response): Promise<Uint8Array> {
  if (!response.body) throw invalidResponse(response)
  const reader = response.body.getReader()
  const bytes = Buffer.alloc(64 * 1024)
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > 64 * 1024) throw new ControlFailure('payload-too-large')
      bytes.set(chunk.value, size - chunk.value.byteLength)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return bytes.subarray(0, size)
}

function parseEmpty<T>(parse: (value: unknown) => Parsed<T>): T {
  const parsed = parse(undefined)
  if (!parsed.ok) throw new ControlFailure('internal')
  return parsed.value
}

export async function parseResponse<T>(
  response: Response,
  parse: (value: unknown) => Parsed<T>,
  empty = false,
): Promise<T> {
  // Unknown and removed Hosts are indistinguishable, even with a broken error body.
  if (response.status === 410) {
    await response.body?.cancel().catch(() => {})
    throw new ControlFailure('gone')
  }
  if (empty && response.status === 204) {
    const length = response.headers.get('content-length')
    if ((length !== null && length !== '0') || response.headers.has('transfer-encoding')) {
      throw new ControlFailure('internal')
    }
    if (response.body === null) return parseEmpty(parse)
  }
  const bytes = await readBody(response)
  if (empty && response.status === 204 && bytes.byteLength === 0) return parseEmpty(parse)
  if (!(response.headers.get('content-type') ?? '').match(/^application\/json(?:;|$)/i)) {
    throw invalidResponse(response)
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  } catch {
    throw invalidResponse(response)
  }
  if (!response.ok) {
    const parsed = parseControlError(value)
    if (!parsed || CONTROL_ERROR_STATUS[parsed.error.code] !== response.status) {
      throw invalidResponse(response)
    }
    throw new ControlFailure(parsed.error.code)
  }
  if (empty || response.status !== 200) throw new ControlFailure('internal')
  const parsed = parse(value)
  if (!parsed.ok) throw new ControlFailure('internal')
  return parsed.value
}

import { describe, expect, it, vi } from 'vitest'
import {
  CONTROL_ERROR_STATUS,
  type ControlErrorCode,
  type Parsed,
} from '@phosphor/shared/control-api'
import { ControlFailure as PublicControlFailure } from './client'
import { ControlFailure, parseResponse } from './client-response'

const parse = (value: unknown): Parsed<unknown> => ({ ok: true, value })
const reject = (): Parsed<never> => ({ ok: false, reason: 'private parser details' })
const body204 = (body: string) => {
  const response = new Response(body)
  Object.defineProperty(response, 'status', { value: 204 })
  return response
}

function streamed(chunks: Uint8Array[], status = 200) {
  const cancel = vi.fn()
  const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
    const chunk = chunks.shift()
    if (chunk) controller.enqueue(chunk)
    else controller.close()
  })
  return {
    cancel,
    pull,
    response: new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  }
}

describe('control response policy', () => {
  it('keeps the original public failure constructor and safe messages', () => {
    expect(ControlFailure).toBe(PublicControlFailure)
    expect(new ControlFailure('offline').message).toBe('The control plane could not be reached.')
    expect(new ControlFailure('internal').message).toBe('Control request failed (internal).')
  })

  it('decodes multibyte UTF-8 across chunks only after bounded collection', async () => {
    const bytes = Buffer.from(JSON.stringify({ text: 'é🐝' }))
    const { response, pull } = streamed(Array.from(bytes, (byte) => new Uint8Array([byte])))
    await expect(parseResponse(response, parse)).resolves.toEqual({ text: 'é🐝' })
    expect(pull).toHaveBeenCalledTimes(bytes.length + 1)
  })

  it('allows exactly 64KiB and cancels before reading beyond the first overflowing chunk', async () => {
    const bytes = Buffer.from('{}' + ' '.repeat(65534))
    await expect(
      parseResponse(streamed([bytes.subarray(0, 1024), bytes.subarray(1024)]).response, parse),
    ).resolves.toEqual({})
    const { response, cancel, pull } = streamed([bytes, Buffer.from(' '), Buffer.from('unread')])
    await expect(parseResponse(response, parse)).rejects.toMatchObject({
      code: 'payload-too-large',
    })
    expect(cancel).toHaveBeenCalledOnce()
    expect(pull).toHaveBeenCalledTimes(2)
  })

  it('propagates read failures and attempts cancellation even when the stream errors', async () => {
    const error = new Error('private transport details')
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(error)
        },
      }),
    )
    const original = response.body?.getReader.bind(response.body)
    if (!original || !response.body) throw new Error('missing stream')
    const reader = original()
    const cancel = vi.spyOn(reader, 'cancel')
    vi.spyOn(response.body, 'getReader').mockReturnValue(reader)
    await expect(parseResponse(response, parse)).rejects.toBe(error)
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('ignores cancellation failures after oversize and preserves the policy failure', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(65537))
        },
        cancel() {
          throw new Error('private cancellation details')
        },
      }),
    )
    await expect(parseResponse(response, parse)).rejects.toMatchObject({
      code: 'payload-too-large',
    })
  })

  it('prioritizes gone over all response parsing and cancels without reading', async () => {
    const { response, cancel, pull } = streamed([Buffer.from('unread')], 410)
    const parser = vi.fn(parse)
    await expect(parseResponse(response, parser)).rejects.toMatchObject({ code: 'gone' })
    expect(pull).not.toHaveBeenCalled()
    expect(cancel).toHaveBeenCalledOnce()
    expect(parser).not.toHaveBeenCalled()
    await expect(parseResponse(new Response(null, { status: 410 }), parse)).rejects.toMatchObject({
      code: 'gone',
    })
  })

  it('ignores cancellation failures for gone responses', async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error('secret')
        },
      }),
      { status: 410 },
    )
    await expect(parseResponse(response, parse)).rejects.toMatchObject({ code: 'gone' })
  })

  it.each([
    () => new Response(null, { status: 204 }),
    () => new Response(null, { status: 204, headers: { 'content-length': '0' } }),
    () => body204(''),
  ])(
    'parses valid empty 204 response %# using undefined without JSON headers',
    async (response) => {
      const parser = vi.fn(parse)
      await expect(parseResponse(response(), parser, true)).resolves.toBeUndefined()
      expect(parser).toHaveBeenCalledExactlyOnceWith(undefined)
      await expect(parseResponse(response(), reject, true)).rejects.toMatchObject({
        code: 'internal',
      })
    },
  )

  it.each([
    () => new Response(null, { status: 204, headers: { 'content-length': '1' } }),
    () => new Response(null, { status: 204, headers: { 'content-length': '00' } }),
    () => new Response(null, { status: 204, headers: { 'transfer-encoding': 'chunked' } }),
    () => body204('x'),
    () => body204('{}'),
    () => Response.json({}),
  ])('rejects invalid revoke framing, nonempty body or success status %#', async (response) => {
    await expect(parseResponse(response(), parse, true)).rejects.toMatchObject({ code: 'internal' })
  })

  it.each([
    ['application/json', true],
    ['Application/JSON; charset=utf-8', true],
    ['application/json;charset=utf-8', true],
    ['application/jsonx', false],
    ['text/json', false],
    ['application/problem+json', false],
    ['', false],
  ])('enforces the JSON media type %s', async (contentType, valid) => {
    const pending = parseResponse(
      new Response('{}', { headers: { 'content-type': contentType } }),
      parse,
    )
    if (valid) await expect(pending).resolves.toEqual({})
    else await expect(pending).rejects.toMatchObject({ code: 'internal' })
  })

  it.each([
    () => new Response(null),
    () => new Response(null, { status: 204 }),
    () => Response.json({}, { status: 201 }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ])('maps invalid successful response %# to internal', async (response) => {
    await expect(parseResponse(response(), parse)).rejects.toMatchObject({ code: 'internal' })
  })

  it('runs the endpoint parser only for valid 200 JSON and rejects its invalid result', async () => {
    const parser = vi.fn(reject)
    await expect(parseResponse(Response.json({}), parser)).rejects.toMatchObject({
      code: 'internal',
    })
    expect(parser).toHaveBeenCalledExactlyOnceWith({})
  })

  it.each(Object.entries(CONTROL_ERROR_STATUS) as Array<[ControlErrorCode, number]>)(
    'maps valid error %s without leaking server messages',
    async (code, status) => {
      const parser = vi.fn(parse)
      await expect(
        parseResponse(Response.json({ error: { code, message: 'secret' } }, { status }), parser),
      ).rejects.toMatchObject({ code, message: `Control request failed (${code}).` })
      expect(parser).not.toHaveBeenCalled()
    },
  )

  it.each([400, 401, 429, 500, 502, 503, 504])(
    'uses status fallback for malformed errors at %s',
    async (status) => {
      for (const response of [
        new Response(null, { status }),
        new Response('private HTML', { status }),
        new Response('{', { status, headers: { 'content-type': 'application/json' } }),
        new Response(new Uint8Array([0xff]), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
        Response.json({ unexpected: 'secret' }, { status }),
        Response.json({ error: { code: 'constructor', message: 'secret' } }, { status }),
        Response.json({ error: { code: 'gone', message: 'secret' } }, { status }),
      ]) {
        const code =
          status === 429 ? 'too-many-requests' : status >= 500 ? 'unavailable' : 'internal'
        await expect(parseResponse(response, parse)).rejects.toMatchObject({
          code,
          message: `Control request failed (${code}).`,
        })
      }
    },
  )
})

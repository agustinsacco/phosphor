import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { handleCallbackRequest, reply, type CallbackRequestState } from './loopback-request'

const state: CallbackRequestState = { port: 12345, path: '/auth/callback/nonce', settled: false }

function fixture(target = `${state.path}?code=abcd-1234`) {
  const req = new IncomingMessage(new Socket())
  req.method = 'GET'
  req.url = target
  req.headers.host = `127.0.0.1:${state.port}`
  const res = new ServerResponse(req)
  const writeHead = vi.spyOn(res, 'writeHead').mockReturnValue(res)
  const end = vi.spyOn(res, 'end').mockReturnValue(res)
  return { req, res, writeHead, end }
}

describe('handleCallbackRequest address validation', () => {
  it.each(['POST', 'HEAD', 'OPTIONS', undefined])(
    'rejects method %s without a callback',
    (method) => {
      const { req, res, writeHead } = fixture()
      req.method = method
      expect(handleCallbackRequest(req, res, state)).toBeNull()
      expect(writeHead).toHaveBeenCalledWith(404, expect.any(Object))
    },
  )

  it.each(['localhost:12345', '127.0.0.1', '127.0.0.1:12346', undefined])(
    'rejects Host %s before inspecting a malformed target',
    (host) => {
      const { req, res, writeHead } = fixture('//')
      req.headers.host = host
      expect(handleCallbackRequest(req, res, state)).toBeNull()
      expect(writeHead).toHaveBeenCalledWith(421, expect.any(Object))
    },
  )

  it.each([
    '/auth/callback',
    '/auth/callback/other?error=denied',
    `${state.path}/extra?code=abcd-1234`,
    `http://evil.example${state.path}?code=abcd-1234`,
    `https://127.0.0.1:12345${state.path}?code=abcd-1234`,
    `/\\evil.example${state.path}?code=abcd-1234`,
  ])('rejects a different origin or path: %s', (target) => {
    const { req, res, writeHead } = fixture(target)
    expect(handleCallbackRequest(req, res, state)).toBeNull()
    expect(writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })

  it('accepts absolute-form targets only when their origin and path match', () => {
    const { req, res, end } = fixture(`http://127.0.0.1:12345${state.path}?code=abcd-1234`)
    expect(handleCallbackRequest(req, res, state)).toEqual({ kind: 'code', code: 'abcd-1234' })
    expect(end).not.toHaveBeenCalled()
  })

  it('leaves parser exceptions for the listener boundary to answer without settling', () => {
    const { req, res, end } = fixture('//')
    expect(() => handleCallbackRequest(req, res, state)).toThrow(TypeError)
    expect(end).not.toHaveBeenCalled()
  })
})

describe('handleCallbackRequest payload validation', () => {
  it.each(['abcd-123', 'A'.repeat(512), 'Ab._~-12'])('accepts a valid code: %s', (code) => {
    const { req, res, end } = fixture(`${state.path}?code=${encodeURIComponent(code)}`)
    expect(handleCallbackRequest(req, res, state)).toEqual({ kind: 'code', code })
    expect(end).not.toHaveBeenCalled()
  })

  it.each(['', 'short', 'A'.repeat(513), 'invalid/code', 'invalid code', 'invalid💥'])(
    'rejects an invalid code: %s',
    (code) => {
      const { req, res, writeHead } = fixture(`${state.path}?code=${encodeURIComponent(code)}`)
      expect(handleCallbackRequest(req, res, state)).toBeNull()
      expect(writeHead).toHaveBeenCalledWith(400, expect.any(Object))
    },
  )

  it('bounds denial fields and accepts a denial when the code is invalid', () => {
    const query = new URLSearchParams({
      code: 'short',
      error: 'e'.repeat(101),
      error_code: 'r'.repeat(101),
      error_description: 'd'.repeat(301),
    })
    const { req, res, end } = fixture(`${state.path}?${query}`)
    expect(handleCallbackRequest(req, res, state)).toEqual({
      kind: 'denied',
      error: 'e'.repeat(100),
      errorCode: 'r'.repeat(100),
      description: 'd'.repeat(300),
    })
    expect(end).not.toHaveBeenCalled()
  })

  it('defaults absent denial details and prefers a valid code over a denial', () => {
    const denial = fixture(`${state.path}?error=access_denied`)
    expect(handleCallbackRequest(denial.req, denial.res, state)).toEqual({
      kind: 'denied',
      error: 'access_denied',
      errorCode: null,
      description: '',
    })
    const code = fixture(`${state.path}?code=abcd-1234&error=access_denied`)
    expect(handleCallbackRequest(code.req, code.res, state)).toEqual({
      kind: 'code',
      code: 'abcd-1234',
    })
  })

  it('checks one-use state before validating the payload, but after the path', () => {
    const used = { ...state, settled: true }
    const callback = fixture(state.path)
    expect(handleCallbackRequest(callback.req, callback.res, used)).toBeNull()
    expect(callback.writeHead).toHaveBeenCalledWith(410, expect.any(Object))
    const unrelated = fixture('/favicon.ico')
    expect(handleCallbackRequest(unrelated.req, unrelated.res, used)).toBeNull()
    expect(unrelated.writeHead).toHaveBeenCalledWith(404, expect.any(Object))
  })
})

describe('reply', () => {
  it('escapes every HTML delimiter in the title and message and confines the page with CSP', () => {
    const { res, writeHead, end } = fixture()
    reply(res, 421, { title: `<script>&"'`, message: `</p><img src="x" onerror='x'>&` })
    expect(writeHead).toHaveBeenCalledWith(421, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'",
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      connection: 'close',
    })
    const html = end.mock.calls[0]?.[0]
    expect(html).toContain('<title>&#60;script&#62;&#38;&#34;&#39;</title>')
    expect(html).toContain('<h1 style="font-size:1.4rem">&#60;script&#62;&#38;&#34;&#39;</h1>')
    expect(html).toContain('&#60;/p&#62;&#60;img src=&#34;x&#34; onerror=&#39;x&#39;&#62;&#38;')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('<img')
  })
})

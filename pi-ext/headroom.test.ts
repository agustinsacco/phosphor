import { describe, it, expect, vi } from 'vitest'
import {
  createHeadroomHandler,
  eligibleText,
  hasUnretrievableOmission,
  mergeDetails,
} from './headroom'

/** A large, valid JSON array — the only shape the extension will compress. */
const BIG = JSON.stringify(
  Array.from({ length: 60 }, (_, i) => ({
    id: `ISS-${i}`,
    title: `Fix flaky test ${i}`.repeat(4),
  })),
)
const textResult = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  toolName: 'mcp__custom-tools__linear_list_issues',
  content: [{ type: 'text', text: BIG }],
  ...overrides,
})

/** fetch stub: /health ok, /v1/compress returns `body` (or rejects). */
function fetchStub(body: unknown): typeof fetch {
  return vi.fn(async (url: string | URL | Request) => {
    if (String(url).endsWith('/health')) return new Response('{"status":"healthy"}')
    if (body instanceof Error) throw body
    return new Response(JSON.stringify(body))
  }) as unknown as typeof fetch
}

const compressed = (text: string, saved = 1000): Record<string, unknown> => ({
  messages: [{ role: 'tool', content: text }],
  tokens_before: 1250,
  tokens_after: 1250 - saved,
  tokens_saved: saved,
})

describe('eligibleText', () => {
  it('accepts a single large JSON text block from a compressible tool', () => {
    expect(eligibleText(textResult())).toBe(BIG)
    expect(eligibleText(textResult({ toolName: 'grep' }))).toBe(BIG)
  })

  it('refuses non-JSON text — that is where the silently-lossy transforms live', () => {
    const prose = 'line of grep output\n'.repeat(400)
    expect(eligibleText(textResult({ content: [{ type: 'text', text: prose }] }))).toBeNull()
  })

  it('refuses truncated JSON, the shape pi produces when it cuts MCP output', () => {
    const cut = BIG.slice(0, BIG.length - 40) + '\n\n[MCP text output truncated]'
    expect(eligibleText(textResult({ content: [{ type: 'text', text: cut }] }))).toBeNull()
  })

  it('refuses JSON scalars even when long', () => {
    const scalar = JSON.stringify('x'.repeat(5000))
    expect(eligibleText(textResult({ content: [{ type: 'text', text: scalar }] }))).toBeNull()
  })

  it('skips excluded tools, errors, small results and odd shapes', () => {
    for (const toolName of ['read', 'write', 'edit', 'bash']) {
      expect(eligibleText(textResult({ toolName }))).toBeNull()
    }
    expect(eligibleText(textResult({ isError: true }))).toBeNull()
    expect(eligibleText(textResult({ content: [{ type: 'text', text: 'small' }] }))).toBeNull()
    expect(eligibleText(textResult({ content: 'not an array' }))).toBeNull()
    expect(
      eligibleText(
        textResult({
          content: [
            { type: 'text', text: BIG },
            { type: 'image', data: '...' },
          ],
        }),
      ),
    ).toBeNull()
    expect(eligibleText({})).toBeNull()
  })
})

describe('hasUnretrievableOmission', () => {
  it('flags the lossy markers seen from the real proxy', () => {
    expect(hasUnretrievableOmission('head\n[4001 lines omitted]\ntail')).toBe(true)
    expect(hasUnretrievableOmission('[2711 lines omitted: 3 ERROR, 2725 INFO]')).toBe(true)
  })

  it('allows retrievable markers and ordinary text', () => {
    expect(hasUnretrievableOmission('[120 lines omitted, hash=abc123]')).toBe(false)
    expect(hasUnretrievableOmission('schema: id,title\nISS-1,Fix build')).toBe(false)
  })
})

describe('mergeDetails', () => {
  const receipt = { savedTokens: 10, beforeTokens: 20, afterTokens: 10, ms: 5 }

  it('keeps existing detail fields and survives non-object details', () => {
    expect(mergeDetails({ rows: 3 }, receipt)).toEqual({ rows: 3, headroom: receipt })
    expect(mergeDetails(undefined, receipt)).toEqual({ headroom: receipt })
    expect(mergeDetails('prose', receipt)).toEqual({ headroom: receipt })
  })
})

describe('createHeadroomHandler', () => {
  const url = 'http://127.0.0.1:8787'

  it('patches content and writes a receipt into details', async () => {
    const handler = createHeadroomHandler({
      baseUrl: url,
      fetchImpl: fetchStub(compressed('short')),
    })
    const patch = await handler(textResult({ details: { rows: 3 } }), {})
    expect(patch?.content).toEqual([{ type: 'text', text: 'short' }])
    const details = patch?.details as { rows: number; headroom: { savedTokens: number } }
    expect(details.rows).toBe(3)
    expect(details.headroom.savedTokens).toBe(1000)
  })

  it('discards a lossy compression and keeps counting the ceiling', async () => {
    const setStatus = vi.fn()
    const handler = createHeadroomHandler({
      baseUrl: url,
      fetchImpl: fetchStub(compressed('[900 lines omitted]', 700)),
    })
    expect(await handler(textResult(), { ui: { setStatus } })).toBeUndefined()
    const totals = JSON.parse(setStatus.mock.calls[0]![1] as string) as Record<string, number>
    expect(totals.skippedLossyTokens).toBe(700)
    expect(totals.results).toBe(0)
  })

  it('ignores a compression that is not smaller', async () => {
    const handler = createHeadroomHandler({
      baseUrl: url,
      fetchImpl: fetchStub(compressed(BIG + 'longer')),
    })
    expect(await handler(textResult(), {})).toBeUndefined()
  })

  it('disables itself for the session when the health probe fails', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('refused')
    }) as unknown as typeof fetch
    const handler = createHeadroomHandler({ baseUrl: url, fetchImpl })
    expect(await handler(textResult(), {})).toBeUndefined()
    expect(await handler(textResult(), {})).toBeUndefined()
    // Health probe only — no per-result retries against a dead proxy.
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('trips the circuit breaker after repeated compress failures', async () => {
    let calls = 0
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      if (String(u).endsWith('/health')) return new Response('{}')
      calls += 1
      throw new Error('boom')
    }) as unknown as typeof fetch
    const handler = createHeadroomHandler({ baseUrl: url, fetchImpl })
    for (let i = 0; i < 5; i += 1) await handler(textResult(), {})
    expect(calls).toBe(3)
  })

  it('does not count a user abort as a proxy failure', async () => {
    const aborted = AbortSignal.abort()
    let compressCalls = 0
    const fetchImpl = vi.fn(async (u: string | URL | Request) => {
      if (String(u).endsWith('/health')) return new Response('{}')
      compressCalls += 1
      throw new Error('aborted')
    }) as unknown as typeof fetch
    const handler = createHeadroomHandler({ baseUrl: url, fetchImpl })
    for (let i = 0; i < 5; i += 1) {
      await handler(textResult(), { signal: aborted })
    }
    // Still trying: every failure happened under an aborted signal.
    expect(compressCalls).toBe(5)
  })

  it('accumulates totals across results on the status channel', async () => {
    const setStatus = vi.fn()
    const handler = createHeadroomHandler({ baseUrl: url, fetchImpl: fetchStub(compressed('s')) })
    await handler(textResult(), { ui: { setStatus } })
    await handler(textResult(), { ui: { setStatus } })
    const totals = JSON.parse(setStatus.mock.calls.at(-1)![1] as string) as Record<string, number>
    expect(totals.results).toBe(2)
    expect(totals.savedTokens).toBe(2000)
    expect(totals.beforeTokens).toBe(2500)
  })
})

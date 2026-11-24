import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import {
  REDACTED,
  REDACT_LIMITS,
  argsSummary,
  canonicalJson,
  freeText,
  mcpConfigSummary,
  redactArgs,
  redactsNothing,
} from './redact'

const spec = (name: string) => {
  const found = OP_CATALOG.find((op) => op.name === name)
  if (!found) throw new Error(`no catalog op ${name}`)
  return found
}
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('redactArgs', () => {
  it('keeps only an MCP config’s transport and URL host, never headers, env, command or args', () => {
    const secrets = ['Bearer sk-live-123', 'ENV_SECRET_VALUE', '/usr/bin/secret-cli', '--token=abc']
    const args = {
      name: 'tracker',
      scope: 'global',
      config: {
        url: 'https://user:pass@mcp.example.com:8443/v1?key=q',
        headers: { Authorization: secrets[0] },
        env: { API_KEY: secrets[1] },
        command: secrets[2],
        args: [secrets[3]],
      },
    }
    const summary = argsSummary(spec('mcp.add'), args)
    expect(JSON.parse(summary)).toEqual({
      name: 'tracker',
      scope: 'global',
      config: { transport: 'http', host: 'mcp.example.com:8443' },
    })
    for (const secret of [...secrets, 'user', 'pass', 'key=q'])
      expect(summary).not.toContain(secret)
    expect(mcpConfigSummary({ command: 'x', args: ['y'] })).toEqual({ transport: 'stdio' })
    expect(mcpConfigSummary({ type: 'http', url: 'not a url' })).toEqual({ transport: 'http' })
  })

  it('stores free text as its first 200 characters plus a SHA-256 of the whole', () => {
    const prompt = `${'é'.repeat(150)}${'🙂'.repeat(100)}`
    const out = redactArgs(spec('lane.create'), { folder: '/w', prompt }) as Record<string, unknown>
    expect(out.prompt).toEqual({
      preview: Array.from(prompt).slice(0, REDACT_LIMITS.freeTextChars).join(''),
      sha256: sha(prompt),
      chars: 250,
    })
    expect(freeText('short')).toEqual({ preview: 'short', sha256: sha('short'), chars: 5 })
    const edit = redactArgs(spec('instructions.edit'), { content: 'x'.repeat(500), revision: null })
    expect((edit as { content: { preview: string } }).content.preview).toHaveLength(200)
  })

  it('replaces other sensitive args and credential-named keys at any depth', () => {
    expect(redactArgs(spec('routine.edit'), { id: 'r1', patch: { title: 't' } })).toEqual({
      id: 'r1',
      patch: REDACTED,
    })
    expect(
      redactArgs(
        { name: 'settings.set' },
        { key: 'x', value: { nested: { apiKey: 'k', refreshToken: 't', ok: 1 } } },
      ),
    ).toEqual({ key: 'x', value: { nested: { apiKey: REDACTED, refreshToken: REDACTED, ok: 1 } } })
  })

  it('cuts the summary at 2 KiB on a code point and shortens long strings', () => {
    const summary = argsSummary({ name: 'lane.list' }, { a: 'é'.repeat(300), b: 'x'.repeat(5000) })
    expect(Buffer.byteLength(summary, 'utf8')).toBeLessThanOrEqual(REDACT_LIMITS.summaryBytes)
    expect(summary).toContain('…')
    const many = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, '🙂'.repeat(9)]),
    )
    const cut = argsSummary({ name: 'lane.list' }, many)
    expect(Buffer.byteLength(cut, 'utf8')).toBeLessThanOrEqual(REDACT_LIMITS.summaryBytes)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toContain('\uFFFD')
  })
})

describe('canonicalJson and redactsNothing', () => {
  it('serializes equal values the same whatever their key order', () => {
    expect(canonicalJson({ b: [{ y: 1, x: 2 }], a: undefined, c: null })).toBe(
      '{"b":[{"x":2,"y":1}],"c":null}',
    )
  })
  it('is true only when nothing would be removed; length cuts are not redaction', () => {
    expect(redactsNothing(spec('lane.rename'), { ref: 'r', name: 'x'.repeat(300) })).toBe(true)
    expect(redactsNothing(spec('mcp.remove'), { name: 'n', scope: 'global' })).toBe(true)
    expect(redactsNothing(spec('mcp.update'), { name: 'n', scope: 'global', config: {} })).toBe(
      false,
    )
    expect(redactsNothing(spec('instructions.edit'), { content: 'a', revision: null })).toBe(false)
  })
})

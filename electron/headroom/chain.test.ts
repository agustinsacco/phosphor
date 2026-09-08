import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHeadroomSupervisor, proxyUrl, type HeadroomSupervisor } from './proxy'
import { createHeadroomHandler } from '../../pi-ext/headroom'
import { parseSessionFile } from '../pi/session-scanner'

/**
 * The whole compression chain against a REAL process and a REAL socket:
 *
 *   supervisor spawns a proxy → PHOSPHOR_HEADROOM_URL → the bundled
 *   extension compresses a tool result → the receipt it writes → the fold
 *   that turns receipts into the number the Optimization tab shows.
 *
 * Every other test in this feature injects the boundary it is testing, which
 * is why the pieces can drift while all of them stay green: the app-rename
 * shipped a supervisor exporting PIDEX_HEADROOM_URL and an extension reading
 * PHOSPHOR_HEADROOM_URL, and nothing failed. This test spans the seams, so a
 * mismatched env var, a broken argv contract or a receipt shape the fold does
 * not recognise fails here.
 *
 * The proxy is `__fixtures__/fake-headroom.cjs` — strict about the argv and
 * env Phosphor promises, and a genuinely lossless restructurer, so "no record
 * was lost" is a real assertion.
 */

const isWindows = process.platform === 'win32'

/** 120 records shaped like a connector export: the payload Headroom is for. */
function issueExport(count: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, i) => ({
      id: `ISS-${String(i).padStart(4, '0')}`,
      title: `Fix flaky test in module ${i % 3}`,
      state: i % 2 === 0 ? 'closed' : 'open',
      priority: (i % 4) + 1,
      createdAt: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
      url: `https://tracker.example/issues/ISS-${String(i).padStart(4, '0')}`,
    })),
  )
}

function toolResultEvent(text: string): Record<string, unknown> {
  return {
    toolName: 'mcpScript',
    content: [{ type: 'text', text }],
    details: { mode: 'script' },
    isError: false,
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

describe.skipIf(isWindows)('the compression chain, end to end', () => {
  let dir: string
  let supervisor: HeadroomSupervisor
  let port: number
  let enabled = true

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-headroom-chain-'))
    port = await freePort()

    // The supervisor spawns the binary directly, so the fixture needs a
    // launcher that is itself executable.
    const launcher = join(dir, 'headroom')
    const fixture = join(__dirname, '__fixtures__', 'fake-headroom.cjs')
    await writeFile(launcher, `#!/bin/sh\nexec ${process.execPath} ${fixture} "$@"\n`, 'utf8')
    await chmod(launcher, 0o755)

    supervisor = createHeadroomSupervisor({
      fetchImpl: fetch,
      spawnImpl: spawn,
      resolveBinaryImpl: async () => launcher,
      envImpl: async () => process.env,
      versionImpl: async () => '0.37.0',
      onWillQuit: () => undefined,
      isEnabled: () => enabled,
      setEnabled: (value) => {
        enabled = value
      },
      logImpl: () => undefined,
      port,
    })
  })

  afterAll(async () => {
    await supervisor?.stop()
    await rm(dir, { recursive: true, force: true })
  })

  it('spawns a proxy that accepts the argv and env Phosphor promises', async () => {
    await supervisor.ensure()
    const status = await supervisor.status()
    // The fixture exits 2 on any contract drift, so a live /health IS the
    // assertion that argv and env arrived intact.
    expect(status.proxy.running).toBe(true)
    expect(status.proxy.owned).toBe(true)
    expect(status.proxy.url).toBe(proxyUrl(port))
  }, 20_000)

  it('hands the session the exact variable the extension reads', async () => {
    const env = supervisor.sessionEnv()
    expect(env).toEqual({ PHOSPHOR_HEADROOM_URL: proxyUrl(port) })

    // Built the way a session builds it: from the env, not from a constant.
    const handler = createHeadroomHandler({
      baseUrl: env.PHOSPHOR_HEADROOM_URL ?? '',
      fetchImpl: fetch,
    })
    const original = issueExport(120)
    const patch = await handler(toolResultEvent(original), {})

    const blocks = patch?.content as Array<{ text: string }> | undefined
    const text = blocks?.[0]?.text ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text.length).toBeLessThan(original.length)
    // Lossless: every id survives, and the receipt says so.
    for (const id of ['ISS-0000', 'ISS-0059', 'ISS-0119']) expect(text).toContain(id)
    expect(patch?.details).toMatchObject({
      mode: 'script', // whatever the tool recorded is kept
      headroom: { savedTokens: expect.any(Number) },
    })
  })

  it('writes a receipt the fold turns back into saved tokens', async () => {
    const handler = createHeadroomHandler({
      baseUrl: proxyUrl(port),
      fetchImpl: fetch,
    })
    const patch = await handler(toolResultEvent(issueExport(120)), {})
    const receipt = (patch?.details as { headroom: { savedTokens: number } }).headroom
    expect(receipt.savedTokens).toBeGreaterThan(0)

    // Exactly how pi persists it: the patched message, one JSONL line.
    const path = join(dir, 'session.jsonl')
    await writeFile(
      path,
      [
        JSON.stringify({
          type: 'session',
          version: 3,
          id: 'chain-1',
          timestamp: '2026-09-08T10:00:00.000Z',
          cwd: dir,
        }),
        JSON.stringify({
          type: 'message',
          id: 'r1',
          parentId: null,
          timestamp: '2026-09-08T10:00:01.000Z',
          message: {
            role: 'toolResult',
            toolName: 'mcpScript',
            content: patch?.content,
            details: patch?.details,
          },
        }),
      ].join('\n') + '\n',
      'utf8',
    )

    const meta = await parseSessionFile(path, Date.now())
    expect(meta?.headroomSavedTokens).toBe(receipt.savedTokens)
  })

  it('keeps the original when the proxy answers with an unretrievable omission', async () => {
    const handler = createHeadroomHandler({ baseUrl: proxyUrl(port), fetchImpl: fetch })
    // Same size, same tool — only the proxy's answer differs.
    const lossy = JSON.stringify([{ __lossy__: true, filler: 'x'.repeat(5000) }])
    expect(await handler(toolResultEvent(lossy), {})).toBeUndefined()
  })

  it('fails open when the proxy dies mid-session', async () => {
    await supervisor.stop()
    expect((await supervisor.status()).proxy.running).toBe(false)

    const handler = createHeadroomHandler({ baseUrl: proxyUrl(port), fetchImpl: fetch })
    const original = issueExport(120)
    // The result passes through untouched, and the session gives up on the
    // proxy rather than paying a failed health probe per tool call.
    expect(await handler(toolResultEvent(original), {})).toBeUndefined()
  }, 20_000)
})

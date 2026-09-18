import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realignSessionCwd } from './session-cwd'

/** A session file shaped like pi's: header line, then entries. */
function sessionFile(cwd: string, body: string[] = []): string {
  const header = JSON.stringify({
    type: 'session',
    version: 3,
    id: '01a0b0b3-28d5-752d-a9bd-4685836bcb15',
    timestamp: '2026-09-17T18:48:46.549Z',
    cwd,
  })
  return [header, ...body, ''].join('\n')
}

function headerOf(text: string): Record<string, unknown> {
  return JSON.parse(text.slice(0, text.indexOf('\n'))) as Record<string, unknown>
}

describe('realignSessionCwd', () => {
  let root: string
  let file: string

  beforeEach(async () => {
    // Resolved: macOS puts the real temp dir under /private, and this module
    // compares against real paths on purpose.
    root = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-session-cwd-')))
    file = join(root, 'session.jsonl')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('points a header at the folder it was found under when the old one is gone', async () => {
    const gone = join(root, 'sandbox-7')
    const here = join(root, 'knowledge & reporting')
    await mkdir(here)
    await writeFile(file, sessionFile(gone, ['{"type":"message","id":"a"}']), 'utf8')

    expect(await realignSessionCwd(file, here)).toBe(true)

    const text = await readFile(file, 'utf8')
    expect(headerOf(text).cwd).toBe(here)
    // Everything else survives: the rest of the transcript byte for byte, and
    // the header's own fields, which pi reads by name.
    expect(text.endsWith('\n{"type":"message","id":"a"}\n')).toBe(true)
    expect(headerOf(text).id).toBe('01a0b0b3-28d5-752d-a9bd-4685836bcb15')
    expect(headerOf(text).version).toBe(3)
  })

  it('rewrites a header naming a different folder that still exists', async () => {
    // Sandbox numbers are reused, so a stale header can point at somebody
    // else's folder rather than at nothing.
    const other = join(root, 'sandbox-7')
    const here = join(root, 'knowledge & reporting')
    await mkdir(other)
    await mkdir(here)
    await writeFile(file, sessionFile(other), 'utf8')

    expect(await realignSessionCwd(file, here)).toBe(true)
    expect(headerOf(await readFile(file, 'utf8')).cwd).toBe(here)
  })

  it('leaves a healthy header alone', async () => {
    await writeFile(file, sessionFile(root), 'utf8')
    const before = await readFile(file, 'utf8')

    expect(await realignSessionCwd(file, root)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('leaves a second spelling of the same folder alone', async () => {
    const real = join(root, 'real')
    const link = join(root, 'link')
    await mkdir(real)
    await symlink(real, link)
    await writeFile(file, sessionFile(link), 'utf8')
    const before = await readFile(file, 'utf8')

    expect(await realignSessionCwd(file, real)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('leaves a file with no session header alone', async () => {
    await writeFile(file, '{"type":"message","id":"a"}\n', 'utf8')
    const before = await readFile(file, 'utf8')

    expect(await realignSessionCwd(file, root)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('leaves a header with no recorded cwd alone', async () => {
    await writeFile(file, '{"type":"session","version":3,"id":"x"}\n', 'utf8')
    const before = await readFile(file, 'utf8')

    expect(await realignSessionCwd(file, root)).toBe(false)
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  it('reports no change for a file that is not there', async () => {
    expect(await realignSessionCwd(join(root, 'missing.jsonl'), root)).toBe(false)
  })

  it('keeps multi-byte content intact on both sides of the header', async () => {
    // The header is found and sliced in a byte buffer; a character-index slice
    // would cut a UTF-8 sequence in half. Sandbox names are free text, so the
    // header itself can carry one.
    const gone = join(root, 'ラボ 🎉')
    const body = ['{"type":"message","text":"日本語 ünïcode 🎉"}']
    await writeFile(file, sessionFile(gone, body), 'utf8')

    expect(await realignSessionCwd(file, root)).toBe(true)

    const text = await readFile(file, 'utf8')
    expect(headerOf(text).cwd).toBe(root)
    expect(text).toContain('日本語 ünïcode 🎉')
  })

  it('leaves no temp files behind', async () => {
    await writeFile(file, sessionFile(join(root, 'sandbox-7')), 'utf8')
    await realignSessionCwd(file, root)

    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})

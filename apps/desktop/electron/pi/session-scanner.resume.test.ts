import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appendFile, mkdir, mkdtemp, rm, truncate, utimes, writeFile } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fold from '@phosphor/session-runtime/pi/session-fold'
import { clearSessionCaches, listSessions, sessionDirNameForCwd } from './session-scanner'

// How the sidebar scan resumes a transcript it has folded before: a proven
// append continues, anything else folds again from the start.

const CWD = '/work/resume'
const line = (value: unknown) => JSON.stringify(value) + '\n'
const header = (id: string) =>
  line({ type: 'session', version: 3, id, timestamp: '2026-08-01T10:00:00.000Z', cwd: CWD })
const user = (id: string, text: string) =>
  line({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-08-01T10:00:01.000Z',
    message: { role: 'user', content: text, timestamp: 1 },
  })

let root: string, wsDir: string, previous: string | undefined, tick: number
beforeEach(async () => {
  clearSessionCaches()
  previous = process.env.PI_CODING_AGENT_SESSION_DIR
  root = await mkdtemp(join(tmpdir(), 'phosphor-scan-resume-'))
  process.env.PI_CODING_AGENT_SESSION_DIR = root
  wsDir = join(root, sessionDirNameForCwd(CWD))
  await mkdir(wsDir, { recursive: true })
  tick = 1_700_000_000
})
afterEach(async () => {
  vi.restoreAllMocks()
  if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR
  else process.env.PI_CODING_AGENT_SESSION_DIR = previous
  await rm(root, { recursive: true, force: true })
})

/** Every change gets a distinct mtime, so the meta cache never hides it. */
async function bump(path: string): Promise<void> {
  tick += 10
  await utimes(path, tick, tick)
}
async function write(name: string, content: string): Promise<string> {
  const path = join(wsDir, name)
  await writeFile(path, content)
  await bump(path)
  return path
}
const signatureOffsets = (spy: { mock: { calls: unknown[][] } }, path: string) =>
  spy.mock.calls.filter((call) => call[0] === path).map((call) => call[1])
const counts = async () =>
  Object.fromEntries((await listSessions(CWD)).map((m) => [m.sessionId, m.userMessages]))

describe('session scan resume', () => {
  it('continues a proven append from where the last fold stopped', async () => {
    const path = await write('a.jsonl', header('a') + user('u1', 'one'))
    expect(await counts()).toEqual({ a: 1 })
    const first = statSync(path).size
    const signatures = vi.spyOn(fold, 'readSignature')
    await appendFile(path, user('u2', 'two'))
    await bump(path)
    expect(await counts()).toEqual({ a: 2 })
    expect(signatureOffsets(signatures, path)).toEqual([first, statSync(path).size])
  })

  it('folds again from the start after a rewrite, even one of the same length', async () => {
    const path = await write('a.jsonl', header('a') + user('u1', 'one') + user('u2', 'two'))
    expect(await counts()).toEqual({ a: 2 })
    await writeFile(path, header('a') + user('u1', 'one') + user('u2', 'TWO'))
    await bump(path)
    const signatures = vi.spyOn(fold, 'readSignature')
    expect(await counts()).toEqual({ a: 2 })
    expect(signatureOffsets(signatures, path)).toEqual([statSync(path).size])
    const before = statSync(path).size
    await writeFile(path, header('a') + user('x1', 'other') + user('x2', 'more') + user('x3', 'x'))
    await bump(path)
    signatures.mockClear()
    expect(await counts()).toEqual({ a: 3 })
    // A grown rewrite is checked against the old boundary, fails, and folds again.
    expect(signatureOffsets(signatures, path)).toEqual([before, statSync(path).size])
  })

  it('folds again from the start after a truncation', async () => {
    const path = await write('a.jsonl', header('a') + user('u1', 'one') + user('u2', 'two'))
    expect(await counts()).toEqual({ a: 2 })
    await truncate(path, (header('a') + user('u1', 'one')).length)
    await bump(path)
    const signatures = vi.spyOn(fold, 'readSignature')
    expect(await counts()).toEqual({ a: 1 })
    expect(signatureOffsets(signatures, path)).toEqual([statSync(path).size])
  })

  it('keeps sixteen resumable folds, dropping the least recently used', async () => {
    const paths: string[] = []
    // One file per scan, so the resumes are kept in this order.
    for (let i = 0; i < 17; i++) {
      paths.push(await write(`s${i}.jsonl`, header(`s${i}`) + user(`u${i}`, 'x')))
      await counts()
    }
    const sizes = paths.map((p) => statSync(p).size)
    const signatures = vi.spyOn(fold, 'readSignature')
    const grow = async (i: number) => {
      await appendFile(paths[i]!, user('more', 'y'))
      await bump(paths[i]!)
      await counts()
      return signatureOffsets(signatures, paths[i]!)
    }
    expect(await grow(0)).toEqual([statSync(paths[0]!).size])
    expect(await grow(16)).toEqual([sizes[16], statSync(paths[16]!).size])
  })

  it('answers null for a header-less file without keeping a resume for it', async () => {
    const path = await write('a.jsonl', user('u1', 'one'))
    expect(await counts()).toEqual({})
    const signatures = vi.spyOn(fold, 'readSignature')
    await appendFile(path, user('u2', 'two'))
    await bump(path)
    expect(await counts()).toEqual({})
    expect(signatureOffsets(signatures, path)).toEqual([])
  })
})

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { appendBranchJump, appendLabel, forkSessionAt } from './session-writer'

vi.mock('node:crypto', () => ({
  randomBytes: () => Buffer.from('11223344', 'hex'),
  randomUUID: () => '00000000-0000-4000-8000-000000000001',
}))

it('preserves exact label, jump and fork bytes, including LF framing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-writer-bytes-'))
  const path = join(dir, 'source.jsonl')
  const timestamp = '2026-08-01T10:00:00.000Z'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(timestamp))
  try {
    const header = '{"type":"session","id":"src"}\n'
    const body = '{ "type": "message", "id": "leaf" }\n'
    await writeFile(path, header + body)
    await appendLabel(path, 'target', 'mark')
    const label = `{"type":"label","id":"11223344","parentId":"leaf","timestamp":"${timestamp}","targetId":"target","label":"mark"}\n`
    expect(await readFile(path, 'utf8')).toBe(header + body + label)
    await appendBranchJump(path, 'target')
    const jump = `{"type":"branch_summary","id":"11223344","parentId":"target","timestamp":"${timestamp}","fromId":"11223344","summary":"Jumped here from another branch in Phosphor (tree view)."}\n`
    expect(await readFile(path, 'utf8')).toBe(header + body + label + jump)

    await writeFile(path, header + body + label + '{"torn":')
    const fork = await forkSessionAt(path, 'target')
    const forkHeader = `{"type":"session","id":"00000000-0000-4000-8000-000000000001","timestamp":"${timestamp}","parentSession":${JSON.stringify(path)}}\n`
    expect(await readFile(fork, 'utf8')).toBe(forkHeader + body + label + jump)
    expect(await readFile(path, 'utf8')).toBe(header + body + label + '{"torn":')
  } finally {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  }
})

it('forks before the first entry as a header-only file, as pi’s own fork writes it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-writer-bytes-'))
  const path = join(dir, 'source.jsonl')
  const timestamp = '2026-08-01T10:00:00.000Z'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(timestamp))
  try {
    const source =
      '{"type":"session","version":3,"id":"src","timestamp":"2026-07-01T00:00:00.000Z","cwd":"/w"}\n' +
      '{"type":"message","id":"first","parentId":null}\n'
    await writeFile(path, source)
    const fork = await forkSessionAt(path, null)
    // pi's `newSession({ parentSession })`: the same keys, in the same order.
    const piHeader = {
      type: 'session',
      version: 3,
      id: '00000000-0000-4000-8000-000000000001',
      timestamp,
      cwd: '/w',
      parentSession: path,
    }
    expect(await readFile(fork, 'utf8')).toBe(JSON.stringify(piHeader) + '\n')
    expect(fork).toBe(
      join(dir, '2026-08-01T10-00-00-000Z_00000000-0000-4000-8000-000000000001.jsonl'),
    )
    expect(await readFile(path, 'utf8')).toBe(source)
  } finally {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  }
})

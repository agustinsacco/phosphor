import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clone, createSession, persist, setName } from './persistence.cjs'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(launchName?: string) {
  const root = mkdtempSync(join(tmpdir(), 'fake-pi-persistence-'))
  roots.push(root)
  return createSession({ sessionFile: undefined, folder: root, cwd: root, launchName })
}

function entries(file: string): Record<string, unknown>[] {
  const disk = readFileSync(file, 'utf8')
  expect(disk.endsWith('\n')).toBe(true)
  return disk
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
}

function expectParents(disk: Record<string, unknown>[]) {
  for (let i = 1; i < disk.length; i++)
    expect(disk[i]).toMatchObject({
      id: expect.any(String),
      parentId: i === 1 ? null : disk[i - 1]!.id,
    })
}

describe('fake pi persistence', () => {
  it('lazily creates its header and launch name, then appends one native parent chain', () => {
    const session = fixture('launch')
    expect(existsSync(session.sessionFile)).toBe(false)
    expect(session.messages).toEqual([])
    const user = { role: 'user', content: 'PHX-first\u2028and\u2029last' }
    persist(session, user)
    const result = { role: 'toolResult', toolCallId: 'call', content: [] }
    persist(session, result)
    setName(session, 'manual')
    const disk = entries(session.sessionFile)
    expect(disk[0]).toEqual({
      type: 'session',
      version: 3,
      id: session.id,
      cwd: session.cwd,
      timestamp: expect.any(String),
    })
    expect(disk.slice(1)).toEqual([
      expect.objectContaining({ type: 'session_info', name: 'launch' }),
      expect.objectContaining({ type: 'message', message: user }),
      expect.objectContaining({ type: 'message', message: result }),
      expect.objectContaining({ type: 'session_info', name: 'manual' }),
    ])
    expectParents(disk)
    expect(session.lastEntryId).toBe(disk.at(-1)!.id)
    expect(session.messages).toEqual([user, result])
    expect(session.selectedName).toBe('manual')
  })

  it('writes an early manual name without later adding the launch name', () => {
    const session = fixture('launch')
    setName(session, 'early')
    const named = entries(session.sessionFile)
    expect(named).toHaveLength(2)
    expect(named[1]).toMatchObject({ type: 'session_info', parentId: null, name: 'early' })
    persist(session, { role: 'user', content: 'hello' })
    const disk = entries(session.sessionFile)
    expect(disk).toHaveLength(3)
    expectParents(disk)
    expect(session.messages).toHaveLength(1)
  })

  it('clones entries without rewriting the source and resumes messages, names and parents', () => {
    const session = fixture()
    persist(session, { role: 'user', content: 'PHX-recall' })
    setName(session, 'retained')
    const source = session.sessionFile
    const before = readFileSync(source, 'utf8')
    const id = session.id
    clone(session)
    expect(session.sessionFile).not.toBe(source)
    expect(session.id).not.toBe(id)
    expect(entries(session.sessionFile).slice(1)).toEqual(entries(source).slice(1))
    const resumed = createSession({
      sessionFile: session.sessionFile,
      folder: session.cwd,
      cwd: session.cwd,
      launchName: undefined,
    })
    expect(resumed.messages).toEqual(session.messages)
    expect(resumed.selectedName).toBe('retained')
    expect(resumed.lastEntryId).toBe(session.lastEntryId)
    // Like the executable, resume gets a fresh in-memory id, not the disk header's id.
    expect(resumed.id).not.toBe(session.id)
    persist(resumed, { role: 'assistant', content: [{ type: 'text', text: 'PHX-recall' }] })
    expectParents(entries(resumed.sessionFile))
    expect(readFileSync(source, 'utf8')).toBe(before)
  })

  it('clones an unwritten session to a header-only file without inventing a name', () => {
    const session = fixture('launch')
    const source = session.sessionFile
    clone(session)
    expect(existsSync(source)).toBe(false)
    expect(entries(session.sessionFile)).toHaveLength(1)
    persist(session, { role: 'user', content: 'first' })
    const disk = entries(session.sessionFile)
    expect(disk).toHaveLength(2)
    expectParents(disk)
    expect(session.messages).toHaveLength(1)
  })
})

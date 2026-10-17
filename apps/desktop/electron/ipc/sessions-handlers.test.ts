import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import type * as FsPromises from 'node:fs/promises'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  sessions: new Map<string, { sessionFile?: string; alive: boolean }>(),
  /** Runs inside every appendFile, after the writer has read the leaf. */
  beforeAppend: undefined as (() => Promise<void>) | undefined,
  trash: vi.fn(),
}))
vi.mock('./handle', () => ({
  handle: (name: string, cb: (...args: unknown[]) => unknown) => state.handlers.set(name, cb),
}))
vi.mock('../registry', () => ({
  registry: {
    get: (id: string) => {
      const s = state.sessions.get(id)
      return s && { sessionId: id, workspacePath: '/work/proj', client: s }
    },
    list: () =>
      [...state.sessions].map(([sessionId, s]) => ({
        sessionId,
        workspacePath: '/work/proj',
        diskPath: s.sessionFile,
      })),
    dispose: async (id: string) => {
      state.sessions.delete(id)
    },
  },
}))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof FsPromises>()
  return {
    ...fs,
    appendFile: async (...args: Parameters<typeof fs.appendFile>) => {
      await state.beforeAppend?.()
      return fs.appendFile(...args)
    },
  }
})
vi.mock('../pi/session-watcher', () => ({
  watchWorkspaceSessions: vi.fn(),
  unwatchWorkspaceSessions: vi.fn(),
}))
vi.mock('../pi/session-deleter', () => ({ deleteSession: state.trash }))
vi.mock('../store', () => ({ clearDraft: vi.fn() }))
vi.mock('../drafts-blobs', () => ({ deleteDraftBlobs: vi.fn() }))
vi.mock('../routines', () => ({ cancelRoutineSession: vi.fn() }))

import { registerSessionsHandlers } from './sessions-handlers'
import { openSessionPath } from '../pi/session-path-lock'
import { ownRoutineSession, releaseRoutineSession } from '../routines/ownership'

const line = (value: unknown): string => JSON.stringify(value) + '\n'
const SOURCE =
  line({ type: 'session', version: 3, id: 'sess-1', timestamp: 't', cwd: '/work/proj' }) +
  line({ type: 'message', id: 'aaaa0001', parentId: null, message: { role: 'user' } }) +
  line({ type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', message: { role: 'assistant' } })

const OPEN = /still open/
const ROUTINE = /running routine/
const MISSING = /no longer exists/

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(handler({}, ...args))
}
const label = (path: string) => invoke('sessions:appendLabel', path, 'aaaa0001', 'mark')
const jump = (path: string) => invoke('sessions:jump', path, 'aaaa0001')
const fork = (path: string) => invoke('sessions:forkAt', path, 'aaaa0001') as Promise<string>
/** Settles at once, so a rejection is never unhandled while a test awaits something else. */
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (error: unknown) => String(error),
  )
function barrier(): { wait: Promise<void>; open: () => void } {
  let open!: () => void
  const wait = new Promise<void>((resolve) => (open = resolve))
  return { wait, open }
}

let dir: string
let source: string
let alias: string

registerSessionsHandlers()

beforeEach(async () => {
  dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-sessions-ipc-')))
  source = join(dir, 'real', '2026-08-01T10-00-00-000Z_sess-1.jsonl')
  await mkdir(join(dir, 'real'))
  await writeFile(source, SOURCE, 'utf8')
  symlinkSync(join(dir, 'real'), join(dir, 'alias'))
  alias = join(dir, 'alias', basename(source))
  state.sessions.clear()
  state.beforeAppend = undefined
  state.trash.mockReset()
  state.trash.mockImplementation(async (path: string) => rmSync(path))
})

afterEach(async () => {
  releaseRoutineSession('routine-1')
  await rm(dir, { recursive: true, force: true })
})

describe('session edit IPCs refuse a transcript another process-local owner holds', () => {
  it('refuses label and jump while a live session owns the file, without a byte changing', async () => {
    state.sessions.set('live-1', { sessionFile: source, alive: true })
    await expect(label(source)).rejects.toThrow(OPEN)
    await expect(jump(source)).rejects.toThrow(OPEN)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('refuses while a disposing session is still registered against the file', async () => {
    state.sessions.set('closing-1', { sessionFile: source, alive: false })
    await expect(label(source)).rejects.toThrow(OPEN)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('matches the owner through a symlinked spelling of the same file', async () => {
    state.sessions.set('live-1', { sessionFile: alias, alive: true })
    await expect(jump(source)).rejects.toThrow(OPEN)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('refuses a routine-owned transcript under its own or canonical spelling', async () => {
    ownRoutineSession('routine-1', source)
    await expect(label(source)).rejects.toThrow(ROUTINE)
    await expect(jump(alias)).rejects.toThrow(ROUTINE)
    releaseRoutineSession('routine-1')
    ownRoutineSession('routine-1')
    state.sessions.set('routine-1', { sessionFile: alias, alive: true })
    await expect(label(source)).rejects.toThrow(ROUTINE)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })
})

describe('session edit IPCs queue with resume and deletion on one path lock', () => {
  it('a resume that already holds the path makes a later edit refuse', async () => {
    const hold = barrier()
    const resume = openSessionPath(alias, async () => {
      state.sessions.set('resumed-1', { sessionFile: alias, alive: true })
      await hold.wait
    })
    const edit = outcome(label(source))
    hold.open()
    await resume
    expect(await edit).toMatch(OPEN)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('an edit that started first finishes before a resume reads the file', async () => {
    const edit = label(source)
    const seen = await openSessionPath(alias, async () => readFileSync(source, 'utf8'))
    await edit
    expect(seen).toContain('"type":"label"')
  })

  it('an edit queued behind a deletion refuses and never recreates the file', async () => {
    const deletion = invoke('sessions:delete', source)
    const edits = [label(alias), jump(source), fork(source)].map(outcome)
    await deletion
    expect(await Promise.all(edits)).toEqual([
      expect.stringMatching(MISSING),
      expect.stringMatching(MISSING),
      expect.stringMatching(MISSING),
    ])
    expect(existsSync(source)).toBe(false)
  })

  it('a deletion queued behind an edit waits for it, so the append cannot resurrect', async () => {
    const reached = barrier()
    const append = barrier()
    state.beforeAppend = async () => {
      reached.open()
      await append.wait
    }
    const edit = label(source)
    await reached.wait
    const deletion = invoke('sessions:delete', alias)
    append.open()
    await edit
    await deletion
    expect(state.trash).toHaveBeenCalledOnce()
    expect(existsSync(source)).toBe(false)
  })
})

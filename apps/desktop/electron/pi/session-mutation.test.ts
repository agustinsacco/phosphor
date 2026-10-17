import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, realpathSync, symlinkSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { appendBranchJump, appendLabel, forkSessionAt } from './session-writer'
import { vi } from 'vitest'
import { readFileSync, readdirSync, rmSync } from 'node:fs'
import { withOfflineSessionMutation, withSessionForkSource } from './session-mutation'
import { openSessionPath, withSessionPath } from './session-path-lock'
import { registry } from '../registry'
import { ownRoutineSession, releaseRoutineSession } from '../routines/ownership'

/**
 * Offline edits to pi's own transcripts. The first block pins what the writer
 * produces today through its original exports; the lock boundary that wraps
 * it must not change a byte of that output.
 */

const HEADER = {
  type: 'session',
  version: 3,
  id: 'sess-uuid-1',
  timestamp: '2026-08-01T10:00:00.000Z',
  cwd: '/work/proj',
}
const line = (value: unknown): string => JSON.stringify(value) + '\n'
const SOURCE =
  line(HEADER) +
  line({ type: 'message', id: 'aaaa0001', parentId: null, message: { role: 'user' } }) +
  line({ type: 'message', id: 'aaaa0002', parentId: 'aaaa0001', message: { role: 'assistant' } })
const LEAF = 'aaaa0002'
const JUMP_SUMMARY = 'Jumped here from another branch in Phosphor (tree view).'

function entries(raw: string): Record<string, unknown>[] {
  expect(raw.endsWith('\n')).toBe(true)
  return raw
    .slice(0, -1)
    .split('\n')
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

let dir: string
let source: string

beforeEach(async () => {
  dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'phosphor-mutation-')))
  source = join(dir, '2026-08-01T10-00-00-000Z_sess-uuid-1.jsonl')
  await writeFile(source, SOURCE, 'utf8')
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('writer output before the lock boundary (characterization)', () => {
  it('appendLabel appends exactly one label line parented on the leaf', async () => {
    await appendLabel(source, 'aaaa0001', 'checkpoint')
    const raw = await readFile(source, 'utf8')
    expect(raw.startsWith(SOURCE)).toBe(true)
    const label = entries(raw.slice(SOURCE.length))
    expect(label).toEqual([
      {
        type: 'label',
        id: expect.stringMatching(/^[0-9a-f]{8}$/),
        parentId: LEAF,
        timestamp: expect.any(String),
        targetId: 'aaaa0001',
        label: 'checkpoint',
      },
    ])
  })

  it('appendBranchJump appends one branch_summary, and nothing at the leaf', async () => {
    await appendBranchJump(source, LEAF)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)

    await appendBranchJump(source, 'aaaa0001')
    const raw = await readFile(source, 'utf8')
    expect(raw.startsWith(SOURCE)).toBe(true)
    expect(entries(raw.slice(SOURCE.length))).toEqual([
      {
        type: 'branch_summary',
        id: expect.stringMatching(/^[0-9a-f]{8}$/),
        parentId: 'aaaa0001',
        timestamp: expect.any(String),
        fromId: LEAF,
        summary: JUMP_SUMMARY,
      },
    ])
  })

  it('forkSessionAt resolves with a sibling that already holds its jump', async () => {
    const fork = await forkSessionAt(source, 'aaaa0001')
    expect(dirname(fork)).toBe(dir)
    expect(basename(fork)).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_[0-9a-f-]{36}\.jsonl$/,
    )
    const [header, ...rest] = entries(await readFile(fork, 'utf8'))
    expect(header).toEqual({
      ...HEADER,
      id: basename(fork).slice(25, -6),
      timestamp: expect.any(String),
      parentSession: source,
    })
    expect(rest.slice(0, 2)).toEqual(entries(SOURCE).slice(1))
    expect(rest.slice(2)).toEqual([
      expect.objectContaining({ type: 'branch_summary', parentId: 'aaaa0001', fromId: LEAF }),
    ])
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('keeps the spelling it was given: a symlinked folder stays in parentSession', async () => {
    const real = join(dir, 'real')
    mkdirSync(real)
    const file = join(real, basename(source))
    await writeFile(file, SOURCE, 'utf8')
    const alias = join(dir, 'alias')
    symlinkSync(real, alias)

    await appendLabel(join(alias, basename(source)), 'aaaa0001', 'via alias')
    expect(entries(await readFile(file, 'utf8')).at(-1)).toMatchObject({ label: 'via alias' })

    const fork = await forkSessionAt(join(alias, basename(source)), 'aaaa0001')
    expect(dirname(fork)).toBe(alias)
    expect(entries(await readFile(fork, 'utf8'))[0]).toMatchObject({
      parentSession: join(alias, basename(source)),
    })
  })

  it('rejects a missing transcript with ENOENT and does not create it', async () => {
    const missing = join(dir, 'gone.jsonl')
    await expect(appendLabel(missing, 'aaaa0001', 'x')).rejects.toThrow(/ENOENT/)
    await expect(appendBranchJump(missing, 'aaaa0001')).rejects.toThrow(/ENOENT/)
    await expect(forkSessionAt(missing, 'aaaa0001')).rejects.toThrow(/ENOENT/)
    expect(existsSync(missing)).toBe(false)
  })
})

/** A live pi appends while a fork reads, so the source can end mid-line. */
const TORN = '{"type":"message","id":"aaaa0003","parentId":"aaaa00'

function unparseable(raw: string): string[] {
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .filter((l) => {
      try {
        JSON.parse(l)
        return false
      } catch {
        return true
      }
    })
}

describe('fork of a transcript that ends in a torn line (regression)', () => {
  it('copies complete lines only, so its jump never merges with the fragment', async () => {
    await writeFile(source, SOURCE + TORN, 'utf8')
    const fork = await forkSessionAt(source, 'aaaa0001')
    const raw = await readFile(fork, 'utf8')
    expect(unparseable(raw)).toEqual([])
    expect(raw).not.toContain(TORN)
    expect(entries(raw).slice(1)).toEqual([
      ...entries(SOURCE).slice(1),
      expect.objectContaining({ type: 'branch_summary', parentId: 'aaaa0001', fromId: LEAF }),
    ])
    expect(await readFile(source, 'utf8')).toBe(SOURCE + TORN)
  })

  it('forks a header followed only by a fragment as a header plus its jump', async () => {
    const header = SOURCE.slice(0, SOURCE.indexOf('\n') + 1)
    await writeFile(source, header + TORN, 'utf8')
    const raw = await readFile(await forkSessionAt(source, 'aaaa0001'), 'utf8')
    expect(unparseable(raw)).toEqual([])
    expect(entries(raw).map((e) => e.type)).toEqual(['session', 'branch_summary'])
  })
})

/* ------------------------------------------------------------------------ */
/* The lock boundary. Owners are real registry entries over a fake pi child, */
/* so a disposing lane stays listed until its process has actually exited.  */
/* ------------------------------------------------------------------------ */

vi.mock('../registry', async () => {
  const { SessionRegistry } = await import('@phosphor/session-runtime/pi/session-registry')
  const { PiRpcClient } = await import('@phosphor/session-runtime/pi/rpc-client')
  return {
    registry: new SessionRegistry({
      createClient: (options) =>
        new PiRpcClient(options, { log: () => undefined, isClosing: () => false }),
      assertCanStart: () => undefined,
    }),
  }
})

const FAKE_PI = join(
  import.meta.dirname,
  '../../../../libs/session-runtime/src/pi/__fixtures__/fake-pi.cjs',
)
/** A running child registered against `path`, as a resumed lane is. */
const laneOn = (path: string) =>
  registry.create(dir, { binaryPath: process.execPath, prefixArgs: [FAKE_PI], sessionPath: path })
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
/** One transcript under two spellings: a real folder and a symlink to it. */
async function twoSpellings(): Promise<{ real: string; alias: string }> {
  const folder = join(dir, 'real')
  mkdirSync(folder)
  symlinkSync(folder, join(dir, 'alias'))
  const real = join(folder, basename(source))
  await writeFile(real, SOURCE, 'utf8')
  return { real, alias: join(dir, 'alias', basename(source)) }
}

describe('withOfflineSessionMutation', () => {
  const label = vi.fn((path: string) => appendLabel(path, 'aaaa0001', 'mark'))
  afterEach(async () => {
    label.mockClear()
    releaseRoutineSession('routine-1')
    await registry.disposeAll()
  })

  it('refuses while a live lane owns the file, without running the write', async () => {
    laneOn(source)
    await expect(withOfflineSessionMutation(source, () => label(source))).rejects.toThrow(
      /still open/,
    )
    expect(label).not.toHaveBeenCalled()
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('refuses while the owner is disposing, and admits once it has exited', async () => {
    const lane = laneOn(source)
    const closing = registry.dispose(lane.sessionId)
    expect(await outcome(withOfflineSessionMutation(source, () => label(source)))).toMatch(
      /still open/,
    )
    await closing
    await withOfflineSessionMutation(source, () => label(source))
    expect(label).toHaveBeenCalledOnce()
  })

  it('compares the owner and the request canonically, symlinks included', async () => {
    const { real, alias } = await twoSpellings()
    laneOn(alias)
    await expect(withOfflineSessionMutation(real, () => label(real))).rejects.toThrow(/still open/)
    await registry.disposeAll()
    laneOn(real)
    await expect(withOfflineSessionMutation(alias, () => label(alias))).rejects.toThrow(
      /still open/,
    )
    expect(await readFile(real, 'utf8')).toBe(SOURCE)
  })

  it('refuses a routine claim by either spelling, and a routine lane in the registry', async () => {
    const { real, alias } = await twoSpellings()
    ownRoutineSession('routine-1', alias)
    await expect(withOfflineSessionMutation(alias, () => label(alias))).rejects.toThrow(
      /running routine/,
    )
    ownRoutineSession('routine-1', real)
    await expect(withOfflineSessionMutation(alias, () => label(alias))).rejects.toThrow(
      /running routine/,
    )
    releaseRoutineSession('routine-1')
    const lane = laneOn(alias)
    ownRoutineSession(lane.sessionId)
    try {
      await expect(withOfflineSessionMutation(real, () => label(real))).rejects.toThrow(
        /running routine/,
      )
    } finally {
      releaseRoutineSession(lane.sessionId)
    }
    expect(label).not.toHaveBeenCalled()
  })

  it('a resume admitted first leaves the queued write to refuse', async () => {
    const hold = barrier()
    const resume = openSessionPath(source, async () => {
      laneOn(source)
      await hold.wait
    })
    const edit = outcome(withOfflineSessionMutation(source, () => label(source)))
    hold.open()
    await resume
    expect(await edit).toMatch(/still open/)
    expect(await readFile(source, 'utf8')).toBe(SOURCE)
  })

  it('a write admitted first finishes before a queued resume reads the file', async () => {
    const edit = withOfflineSessionMutation(source, () => label(source))
    const seen = await openSessionPath(source, async () => readFileSync(source, 'utf8'))
    await edit
    expect(entries(seen).at(-1)).toMatchObject({ type: 'label', label: 'mark' })
  })

  it('a deletion admitted first leaves nothing for the write to recreate', async () => {
    const deletion = withSessionPath(source, async () => rmSync(source))
    const edit = outcome(withOfflineSessionMutation(source, () => label(source)))
    await deletion
    expect(await edit).toMatch(/no longer exists/)
    expect(label).not.toHaveBeenCalled()
    expect(existsSync(source)).toBe(false)
  })

  it('releases the path after a refusal or a failed write', async () => {
    laneOn(source)
    await expect(withOfflineSessionMutation(source, () => label(source))).rejects.toThrow()
    await registry.disposeAll()
    const failing = withOfflineSessionMutation(source, async () => {
      throw new Error('write failed')
    })
    await expect(failing).rejects.toThrow('write failed')
    expect(await openSessionPath(source, async () => 'resumed')).toBe('resumed')
  })

  it('does not hold up an edit to an unrelated transcript', async () => {
    const other = join(dir, 'other.jsonl')
    await writeFile(other, SOURCE, 'utf8')
    const hold = barrier()
    const held = withOfflineSessionMutation(source, () => hold.wait)
    await withOfflineSessionMutation(other, () => label(other))
    expect(entries(await readFile(other, 'utf8')).at(-1)).toMatchObject({ type: 'label' })
    hold.open()
    await held
  })
})

describe('withSessionForkSource', () => {
  afterEach(async () => {
    releaseRoutineSession('routine-1')
    await registry.disposeAll()
  })

  it('forks a live, routine-owned source mid-append without writing it', async () => {
    await writeFile(source, SOURCE + TORN, 'utf8')
    const lane = laneOn(source)
    ownRoutineSession(lane.sessionId, source)
    try {
      const fork = await withSessionForkSource(source, () => forkSessionAt(source, 'aaaa0001'))
      expect(unparseable(await readFile(fork, 'utf8'))).toEqual([])
      expect(await readFile(source, 'utf8')).toBe(SOURCE + TORN)
    } finally {
      releaseRoutineSession(lane.sessionId)
    }
  })

  it('refuses a source a queued deletion already removed', async () => {
    const run = vi.fn(() => forkSessionAt(source, 'aaaa0001'))
    const deletion = withSessionPath(source, async () => rmSync(source))
    const fork = outcome(withSessionForkSource(source, run))
    await deletion
    expect(await fork).toMatch(/no longer exists/)
    expect(run).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual([])
  })

  it('holds the source path until the new file carries its jump', async () => {
    const forked = withSessionForkSource(source, () => forkSessionAt(source, 'aaaa0001'))
    const seen = await openSessionPath(source, async () =>
      readdirSync(dir)
        .filter((name) => name !== basename(source))
        .map((name) => entries(readFileSync(join(dir, name), 'utf8')).at(-1)),
    )
    expect(seen).toEqual([expect.objectContaining({ type: 'branch_summary', fromId: LEAF })])
    expect(basename(await forked)).not.toBe(basename(source))
  })
})

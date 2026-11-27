import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { createReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import type { RuntimeState } from '../session/runtime-state'
import type { RuntimeService } from '../session/runtime-wiring'
import { reserveLane } from '../session/reserved-lanes'
import { sha256 } from './__fixtures__/staged-brain'
import { createBrainAgentTranscriptImport, type BrainAgentBindingPort } from './agent-import'

const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})
const temp = (name: string) => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), `${name}-`)))
  folders.push(folder)
  return folder
}
const DESKTOP_CWD = '/made-up/Phosphor/brain/Brain'
const header = (id: string) =>
  JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-01', cwd: DESKTOP_CWD })
const BODY = `${JSON.stringify({ type: 'message', id: 'a1', message: { role: 'user', content: 'Defrag Harbor — “Tom Lee”' } })}\n`
const OLD = `${header('agent-old')}\n${BODY}`
const ACTIVE = `${header('agent-now')}\n${BODY}`

/** A published Brain with two sealed transcripts and the agent worker's binding. */
function world(options: { bound?: string | null } = {}) {
  const state = temp('harbor-host')
  const sessionsRoot = temp('harbor-sessions')
  const sealed = temp('harbor-sealed')
  const laneFolder = join(state, 'brain', 'Brain')
  mkdirSync(laneFolder, { recursive: true })
  writeFileSync(join(sealed, 'old.jsonl'), OLD)
  writeFileSync(join(sealed, 'now.jsonl'), ACTIVE)
  let bound: string | null = options.bound ?? null
  const binds: (string | null)[] = []
  const binding: BrainAgentBindingPort = {
    read: () => bound,
    bind: (file) => {
      binds.push(file)
      bound = file
    },
  }
  const run = createBrainAgentTranscriptImport({ sessionsRoot, binding })
  const input = {
    migrationId: '00000000-0000-4000-8000-0000000000e1',
    laneFolder,
    active: 'now.jsonl',
    transcripts: [
      { name: 'old.jsonl', sessionId: 'agent-old', file: OLD },
      { name: 'now.jsonl', sessionId: 'agent-now', file: ACTIVE },
    ].map(({ name, sessionId, file }) => ({
      name,
      sessionId,
      path: join(sealed, name),
      sha256: sha256(file),
      bytes: Buffer.byteLength(file),
    })),
  }
  const dir = sessionDirForCwd(laneFolder, sessionsRoot)
  return { run: () => run(input), input, dir, laneFolder, sessionsRoot, binds, bound: () => bound }
}

describe('importing the Brain Agent conversation', () => {
  it('keeps history byte for byte and binds the active one, resuming in the Host lane folder', async () => {
    const w = world()
    expect(await w.run()).toEqual({ bound: join(w.dir, 'now.jsonl') })
    expect(readFileSync(join(w.dir, 'old.jsonl'), 'utf8')).toBe(OLD)
    const active = readFileSync(join(w.dir, 'now.jsonl'), 'utf8')
    const [first, ...rest] = active.split('\n')
    expect(JSON.parse(first!)).toEqual({ ...JSON.parse(header('agent-now')), cwd: w.laneFolder })
    expect(rest.join('\n')).toBe(BODY)
    expect(w.bound()).toBe(join(w.dir, 'now.jsonl'))
  })

  it('is idempotent: a second run binds and copies nothing new', async () => {
    const w = world()
    await w.run()
    expect(await w.run()).toEqual({ bound: join(w.dir, 'now.jsonl') })
    expect(w.binds).toEqual([join(w.dir, 'now.jsonl')])
  })

  it('finishes a publish interrupted between linking the transcript and removing its temporary name', async () => {
    const w = world()
    mkdirSync(w.dir, { recursive: true })
    const partial = join(w.dir, `.import-${w.input.migrationId}-${sha256('old.jsonl')}`)
    writeFileSync(partial, OLD, { mode: 0o600 })
    linkSync(partial, join(w.dir, 'old.jsonl'))
    await expect(w.run()).resolves.toEqual({ bound: join(w.dir, 'now.jsonl') })
    expect(existsSync(partial)).toBe(false)
    expect(readFileSync(join(w.dir, 'old.jsonl'), 'utf8')).toBe(OLD)
  })

  it('refuses two names for an inode unless the second is the exact temporary for this move', async () => {
    const w = world()
    mkdirSync(w.dir, { recursive: true })
    const elsewhere = join(temp('ledger-history'), 'old.jsonl')
    writeFileSync(elsewhere, OLD)
    linkSync(elsewhere, join(w.dir, 'old.jsonl'))
    await expect(w.run()).rejects.toThrow('already holds a different')
    expect(w.binds).toEqual([])
  })

  it('never overwrites a different transcript already in the lane’s folder', async () => {
    const w = world()
    mkdirSync(w.dir, { recursive: true })
    writeFileSync(join(w.dir, 'old.jsonl'), `${header('agent-old')}\n{"Kestrel":1}\n`)
    await expect(w.run()).rejects.toThrow('already holds a different')
    expect(w.binds).toEqual([])
  })

  it('never follows a link planted where a transcript goes', async () => {
    const w = world()
    mkdirSync(w.dir, { recursive: true })
    const elsewhere = join(temp('ledger-elsewhere'), 'old.jsonl')
    writeFileSync(elsewhere, OLD)
    symlinkSync(elsewhere, join(w.dir, 'old.jsonl'))
    await expect(w.run()).rejects.toThrow('already holds a different')
  })

  it('refuses a sealed copy whose header id is not the verified one', async () => {
    const w = world()
    const input = {
      ...w.input,
      transcripts: w.input.transcripts.map((t) => ({ ...t, sessionId: 'x' })),
    }
    const run = createBrainAgentTranscriptImport({
      sessionsRoot: w.sessionsRoot,
      binding: { read: () => null, bind: () => undefined },
    })
    await expect(run(input)).rejects.toThrow('not the verified conversation')
  })

  it('refuses when the lane is already bound to another conversation', async () => {
    const w = world({ bound: '/made-up/other.jsonl' })
    await expect(w.run()).rejects.toThrow('already has a conversation')
    expect(w.binds).toEqual([])
  })

  it('the reserved lane resumes the bound transcript by path', async () => {
    const w = world()
    await w.run()
    const lane = createReservedLane('brain-agent', w.laneFolder)
    const sessions = new Map<string, { reserved: unknown; client: unknown }>()
    const opened: unknown[] = []
    const state = {
      reserved: [],
      life: { assertReady: () => undefined },
      machine: {
        env: { PI_CODING_AGENT_SESSION_DIR: w.sessionsRoot },
        log: { hide: (t: string) => t },
      },
      registry: { get: (id: string) => sessions.get(id) },
    } as unknown as RuntimeState
    const service = {
      create: async (options: unknown) => {
        opened.push(options)
        sessions.set('brain-1', { reserved: lane, client: {} })
        return { sessionId: 'brain-1' }
      },
    } as unknown as RuntimeService
    const runtime = reserveLane(state, service, lane)
    await runtime.open({ sessionPath: w.bound()! }, () => undefined)
    expect(opened).toEqual([{ workspacePath: w.laneFolder, sessionPath: join(w.dir, 'now.jsonl') }])
  })
})

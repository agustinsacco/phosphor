import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { createReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { createHostLog } from '../machine/log'
import { createHostRuntime, RequestError, type HostRuntime } from './runtime'

const FAKE_PI = join(import.meta.dirname, '../__fixtures__/fake-pi.cjs')

let dir: string
let repo: string
let folder: string
let current: HostRuntime | undefined

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-host-reserved-'))
  repo = join(dir, 'harbor')
  folder = join(dir, 'state', 'brain', 'Brain')
  mkdirSync(repo)
  mkdirSync(folder, { recursive: true })
  vi.stubEnv('PI_CODING_AGENT_DIR', join(dir, 'agent'))
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(async () => {
  const draining = current?.drain('test over')
  void current?.drain('test over, hurried')
  await draining
  current = undefined
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A Host whose configured repositories include the Brain folder itself: a cwd grants nothing. */
function boot(roots = [repo, folder]) {
  const runtime = createHostRuntime(
    {
      pi: { binaryPath: process.execPath, prefixArgs: [FAKE_PI] },
      env: { PATH: process.env.PATH!, HOME: dir, PI_CODING_AGENT_DIR: join(dir, 'agent') },
      roots,
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      machineContext: { kind: 'host', label: 'Harbor', os: 'Linux', repositories: [] },
      log: createHostLog(join(dir, 'logs'), []),
    },
    { dialogs: 'forward' },
  )
  current = runtime
  runtime.life.to('validating')
  runtime.life.to('ready')
  return runtime
}

describe('a reserved lane in the Host runtime', { timeout: 20_000 }, () => {
  it('is invisible to the ordinary list and refused by id on every ordinary route', async () => {
    const runtime = boot()
    const reserved = runtime.reserve(createReservedLane('brain-agent', folder))
    const own = await reserved.open({ name: 'Brain Agent' }, () => {})
    const ordinary = await runtime.start({ repository: repo })
    expect(runtime.list().map((s) => s.sessionId)).toEqual([ordinary.sessionId])
    const unknown = `Unknown session: ${own.sessionId}`
    await expect(runtime.command(own.sessionId, { type: 'get_state' })).rejects.toThrow(unknown)
    await expect(runtime.stop(own.sessionId)).rejects.toThrow(unknown)
    await expect(runtime.exportHtml(own.sessionId, 1000)).rejects.toThrow(unknown)
    await expect(runtime.mcpControl(own.sessionId, 'x', 'inspect')).rejects.toThrow(unknown)
    expect(await runtime.reloadNow(own.sessionId)).toBe('failed')
    expect(() =>
      runtime.extensionUiResponse(own.sessionId, {
        type: 'extension_ui_response',
        id: 'd1',
        cancelled: true,
      }),
    ).toThrow('the session is not running')
    expect(() => runtime.routineClient(own.sessionId)).toThrow('not a routine session')
    // Its own runtime still reaches it.
    expect((await reserved.command(own.sessionId, { type: 'get_state' })).success).toBe(true)
  })

  it('refuses its folder, transcripts and files to ordinary start, resume and deletion', async () => {
    const runtime = boot()
    const reserved = runtime.reserve(createReservedLane('brain-agent', folder))
    const own = await reserved.open({ name: 'Brain Agent' }, () => {})
    const state = await reserved.command(own.sessionId, { type: 'get_state' })
    const file = (state as { data?: { sessionFile: string } }).data!.sessionFile
    await reserved.stop(own.sessionId)
    await expect(runtime.start({ repository: folder })).rejects.toBeInstanceOf(RequestError)
    await expect(runtime.start({ repository: folder, sessionPath: file })).rejects.toBeInstanceOf(
      RequestError,
    )
    await expect(runtime.remove({ repository: folder, sessionPath: file })).rejects.toBeInstanceOf(
      RequestError,
    )
    await expect(runtime.withSessionFile(file, async () => 'read')).rejects.toThrow(
      'not a lane file',
    )
    await expect(runtime.mutateStoppedSession(file, async () => 'moved')).rejects.toThrow(
      'not a lane file',
    )
    mkdirSync(join(folder, 'inner'))
    await expect(runtime.start({ repository: join(folder, 'inner') })).rejects.toBeInstanceOf(
      RequestError,
    )
  })

  it('opens only its own folder and transcripts, and never takes an ordinary session', async () => {
    const runtime = boot()
    const reserved = runtime.reserve(createReservedLane('brain-agent', folder))
    const ordinary = await runtime.start({ repository: repo })
    await expect(reserved.command(ordinary.sessionId, { type: 'get_state' })).rejects.toThrow(
      `Unknown session: ${ordinary.sessionId}`,
    )
    await expect(reserved.stop(ordinary.sessionId)).rejects.toThrow('Unknown session')
    const elsewhere = join(sessionDirForCwd(repo), 'copied.jsonl')
    mkdirSync(sessionDirForCwd(repo), { recursive: true })
    writeFileSync(elsewhere, '')
    await expect(reserved.open({ sessionPath: elsewhere }, () => {})).rejects.toThrow(
      'not this lane’s transcript',
    )
    expect(() => runtime.reserve(createReservedLane('brain-agent', folder))).toThrow(
      'already reserved',
    )
  })

  it('reuses its live process when asked to open the transcript it is running', async () => {
    const runtime = boot([repo])
    const reserved = runtime.reserve(createReservedLane('brain-agent', folder))
    const first = await reserved.open({ name: 'Brain Agent' }, () => {})
    const state = await reserved.command(first.sessionId, { type: 'get_state' })
    const file = (state as { data?: { sessionFile: string } }).data!.sessionFile
    const again = await reserved.open({ sessionPath: file }, () => {})
    expect(again.sessionId).toBe(first.sessionId)
    expect(reserved.client(first.sessionId)?.alive).toBe(true)
  })
})

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import type { SessionPush } from '@phosphor/shared/models'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EXTENSIONS_ROOT, SECRET } from '../__fixtures__/machine'
import { buildPiEnvironment } from '../machine/environment'
import { createHostLog, type HostLog } from '../machine/log'
import { isGone, type DrainTimings } from './lifecycle'
import { createHostRuntime, RequestError, unlinkTranscript, type HostRuntime } from './runtime'

const FAKE_PI = join(import.meta.dirname, '../__fixtures__/fake-pi.cjs')
const TIMINGS: DrainTimings = { abortMs: 2000, graceMs: 1000, deadlineMs: 10_000, settleMs: 1000 }

let dir: string
let repo: string
let agentDir: string
let current: HostRuntime | undefined

beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-host-runtime-'))
  repo = join(dir, 'repo')
  agentDir = join(dir, 'agent')
  mkdirSync(repo)
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
  // The runtime gives this process pi's PATH; the stub puts the old one back.
  vi.stubEnv('PATH', process.env.PATH)
})
afterEach(async () => {
  // A second request kills at once, whatever a failed test left running.
  const draining = current?.drain('test over')
  void current?.drain('test over, hurried')
  await draining
  current = undefined
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

/** A Host on the fake pi, with pi's environment built from a poisoned one, as doctor builds it. */
function boot(
  options: {
    env?: Record<string, string>
    timings?: Partial<DrainTimings>
    ready?: boolean
  } = {},
) {
  const environment = buildPiEnvironment({
    hostEnv: {
      HOME: dir,
      USER: 'me',
      PI_CODING_AGENT_DIR: agentDir,
      ANTHROPIC_API_KEY: SECRET,
      NODE_OPTIONS: '--require=/nonexistent/hook.js',
      LD_PRELOAD: '/tmp/hook.so',
      DYLD_INSERT_LIBRARIES: '/tmp/hook.dylib',
      BASH_ENV: '/tmp/hook.sh',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      PATH: '.:/tmp',
      ...options.env,
    },
    pass: Object.keys(options.env ?? {}),
    nodePath: process.execPath,
    platform: process.platform,
  })
  const log = createHostLog(join(dir, 'logs'), environment.secrets)
  const runtime = createHostRuntime(
    {
      pi: { binaryPath: process.execPath, prefixArgs: [FAKE_PI] },
      env: environment.env,
      roots: [repo],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log,
    },
    { timings: { ...TIMINGS, ...options.timings } },
  )
  current = runtime
  if (options.ready !== false) {
    runtime.life.to('validating')
    runtime.life.to('ready')
  }
  return { runtime, environment, log }
}

/** A delivery that keeps every push. */
function recorder() {
  const pushes: SessionPush[] = []
  return {
    deliver: (push: SessionPush) => void pushes.push(push),
    stderr: (prefix: string) =>
      pushes.flatMap((p) => (p.kind === 'stderr' && p.text.startsWith(prefix) ? [p.text] : [])),
    events: (type: string) => pushes.filter((p) => p.kind === 'event' && p.event.type === type),
    requests: (method: string) =>
      pushes.filter((p) => p.kind === 'extension-ui' && p.request.method === method),
  }
}

async function until<T>(find: () => T | undefined | false, what: string): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const found = find()
    if (found) return found
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

async function sessionFile(runtime: HostRuntime, id: string): Promise<string> {
  const state = await runtime.command(id, { type: 'get_state' })
  if (!state.success) throw new Error(state.error)
  return (state.data as { sessionFile: string }).sessionFile
}

const transcript = (file: string): unknown[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as unknown)

/** What PiRpcClient logged for each spawn. */
const spawns = (log: HostLog) =>
  readFileSync(log.path()!, 'utf8')
    .split('\n')
    .flatMap((line) => {
      const found = /\[pi\] spawn (\{.*\})$/.exec(line)
      return found ? [JSON.parse(found[1]!) as { args: string[]; cwd: string }] : []
    })

describe('the Host runtime', { timeout: 20_000 }, () => {
  it("starts pi with its built environment only, the bundled extensions, and pi's PATH", async () => {
    const { runtime, environment, log } = boot()
    const sink = recorder()
    await runtime.start({ repository: repo }, sink.deliver)
    const names = await until(
      () => sink.stderr('FAKE_PI_ENV ').at(0)?.slice(12).split(','),
      'names',
    )
    // macOS gives every process this one, whatever its parent passed.
    expect(names.filter((name) => name !== '__CF_USER_TEXT_ENCODING')).toEqual(
      [...environment.names, 'PI_CLAUDE_CLI_CONTEXT'].sort(),
    )
    const path = await until(() => sink.stderr('FAKE_PI_PATH ').at(0)?.slice(13), 'PATH')
    expect(path).toBe(environment.env.PATH)
    expect(path.split(':')).not.toContain('.')
    expect(path.split(':')).not.toContain('/tmp')
    expect(process.env.PATH).toBe(path)
    const [spawn] = spawns(log)
    expect(spawn!.cwd).toBe(repo)
    const extensions = spawn!.args.flatMap((arg, i) => (arg === '-e' ? [spawn!.args[i + 1]!] : []))
    expect(extensions).toHaveLength(6)
    for (const file of extensions) expect(dirname(file)).toBe(join(EXTENSIONS_ROOT, 'pi-ext'))
  })

  it('plays a turn and saves it, stops, resumes from the file, and refuses a second start', async () => {
    const { runtime } = boot()
    const sink = recorder()
    const first = await runtime.start({ repository: repo, name: 'First' }, sink.deliver)
    const prompt = { type: 'prompt', message: 'Reply with PHX-abc123' } as const
    expect((await runtime.command(first.sessionId, prompt)).success).toBe(true)
    await until(() => sink.events('agent_end').length === 1, 'the turn')
    const file = await sessionFile(runtime, first.sessionId)
    expect(dirname(file)).toBe(sessionDirForCwd(repo))
    expect(transcript(file).at(-1)).toMatchObject({
      message: { content: [{ text: 'PHX-abc123' }], stopReason: 'stop' },
    })
    const resume = { repository: repo, sessionPath: file }
    await expect(runtime.start(resume)).rejects.toThrow('the session is already running')
    await runtime.stop(first.sessionId)
    expect(runtime.list()).toEqual([])
    expect(isGone(first.pid!)).toBe(true)

    const resumed = await runtime.start(resume)
    expect(resumed.sessionId).not.toBe(first.sessionId)
    expect(await sessionFile(runtime, resumed.sessionId)).toBe(file)
    await runtime.stop(resumed.sessionId)
    // Two starts at once: one pi, and the other start refused.
    const both = await Promise.allSettled([runtime.start(resume), runtime.start(resume)])
    expect(both.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(both.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { message: 'the session is already running' },
    })
    expect(runtime.list()).toHaveLength(1)
  })

  it('cancels each dialog at once, since nothing can answer one yet, and still delivers it', async () => {
    const { runtime, log } = boot()
    const sink = recorder()
    const { sessionId } = await runtime.start({ repository: repo }, sink.deliver)
    // A status is not a dialog: it waits for nothing.
    await until(() => sink.requests('setStatus').length === 1, 'the breakdown status')
    const asked = await runtime.command(sessionId, { type: 'prompt', message: '/fake-ask' })
    expect(asked.success).toBe(true)
    // stderr is another pipe: it may land after the answer on stdout.
    expect(await until(() => sink.stderr('FAKE_PI_DIALOG ').at(0), 'the dialog answer')).toBe(
      'FAKE_PI_DIALOG {"cancelled":true}',
    )
    expect(sink.requests('confirm')).toHaveLength(1)
    const written = readFileSync(log.path()!, 'utf8')
    expect(written).toMatch(
      /\[host\] dialog cancelled \{"sessionId":"[^"]+","method":"confirm","title":"Allow\?"\}/,
    )
    expect(written.match(/dialog cancelled/g)).toHaveLength(1)
  })

  it('deletes only a stopped session, and only by a request for its file', async () => {
    const { runtime } = boot()
    const sink = recorder()
    const { sessionId } = await runtime.start({ repository: repo }, sink.deliver)
    await runtime.command(sessionId, { type: 'prompt', message: 'PHX-one' })
    await until(() => sink.events('agent_end').length === 1, 'the turn')
    const file = await sessionFile(runtime, sessionId)
    const request = { repository: repo, sessionPath: file }
    await expect(runtime.remove(request)).rejects.toThrow('the session is running: stop it first')
    expect(existsSync(file)).toBe(true)
    expect(runtime.list()).toHaveLength(1)
    await runtime.stop(sessionId)
    await runtime.remove(request)
    expect(existsSync(file)).toBe(false)
    const again = runtime.remove({ ...request, model: 'x' })
    await expect(again).rejects.toBeInstanceOf(RequestError)
    await expect(again).rejects.toMatchObject({
      errors: [
        { pointer: '/model', message: 'is not a request field' },
        { pointer: '/sessionPath', message: 'does not exist' },
      ],
    })
  })

  it('refuses a command that moves pi to another file or hands it a path', async () => {
    const { runtime } = boot()
    const { sessionId } = await runtime.start({ repository: repo })
    const path = join(dir, 'elsewhere.jsonl')
    const moves = 'moves pi to another session file: start or resume one with a request instead'
    for (const [command, message] of [
      [{ type: 'switch_session', sessionPath: path }, `switch_session ${moves}`],
      [{ type: 'new_session' }, `new_session ${moves}`],
      [{ type: 'new_session', parentSession: path }, `new_session ${moves}`],
      [{ type: 'fork', entryId: 'entry' }, `fork ${moves}`],
      [{ type: 'clone' }, `clone ${moves}`],
      [{ type: 'export_html', outputPath: path }, 'export_html takes no output path on a Host'],
      [{ type: 'rm' }, 'not a pi command'],
      [{ type: 'constructor' }, 'not a pi command'],
      [{}, 'not a pi command'],
    ] as const) {
      // Refused here: the fake would answer each of them, as unsupported.
      await expect(runtime.command(sessionId, command as never)).rejects.toThrow(message)
    }
    expect(await runtime.command(sessionId, { type: 'export_html' })).toMatchObject({
      success: false,
      error: 'unsupported in fake',
    })
  })

  it.each([
    ['/fake-clone', true],
    ['/fake-clone-fails', false],
  ])('follows an extension command that moves pi to another file: %s', async (message, success) => {
    const { runtime } = boot()
    const { sessionId } = await runtime.start({ repository: repo })
    const first = await sessionFile(runtime, sessionId)
    const prompt = { type: 'prompt', message } as const
    expect(await runtime.command(sessionId, prompt)).toMatchObject({ success })
    // Found on disk, as anyone could: no get_state told this test where pi went.
    const folder = dirname(first)
    const moved = readdirSync(folder)
      .map((name) => join(folder, name))
      .filter((file) => file !== first)
    expect(moved).toHaveLength(1)
    const request = { repository: repo, sessionPath: moved[0]! }
    await expect(runtime.start(request)).rejects.toThrow('the session is already running')
    await expect(runtime.remove(request)).rejects.toThrow('the session is running: stop it first')
    expect(existsSync(request.sessionPath)).toBe(true)
    expect(runtime.list()).toHaveLength(1)
  })

  it.each(['reply', 'state'])(
    'admits no resume or deletion while pi may be moving: its %s held',
    async (held) => {
      const { runtime } = boot()
      const { sessionId } = await runtime.start({ repository: repo })
      const first = await sessionFile(runtime, sessionId)
      const release = join(dir, 'release')
      const message = `/fake-clone-hold-${held} ${release}`
      const prompt = runtime.command(sessionId, { type: 'prompt', message })
      // pi has moved. Its answer, or the Host's question about its file, waits.
      await until(() => existsSync(`${release}.held`), 'the hold')
      const folder = dirname(first)
      const moved = readdirSync(folder)
        .map((name) => join(folder, name))
        .filter((file) => file !== first)
      expect(moved).toHaveLength(1)
      const request = { repository: repo, sessionPath: moved[0]! }
      const busy =
        'a session is running a command that may move it to another file: try again once it ends'
      await expect(runtime.start(request)).rejects.toThrow(busy)
      await expect(runtime.remove(request)).rejects.toThrow(busy)
      // A new session's file is new, so nothing holds it up.
      await runtime.start({ repository: repo })
      writeFileSync(release, '')
      expect(await prompt).toMatchObject({ success: true })
      await expect(runtime.start(request)).rejects.toThrow('the session is already running')
      await expect(runtime.remove(request)).rejects.toThrow('the session is running: stop it first')
      expect(existsSync(request.sessionPath)).toBe(true)
      expect(runtime.list()).toHaveLength(2)
    },
  )

  /** A session that has moved and whose get_state then fails or names no file, as `message` makes it. */
  async function loseTrack(runtime: HostRuntime, message: string) {
    const { sessionId } = await runtime.start({ repository: repo })
    const first = await sessionFile(runtime, sessionId)
    expect(await runtime.command(sessionId, { type: 'prompt', message })).toMatchObject({
      success: true,
    })
    const folder = dirname(first)
    const moved = readdirSync(folder)
      .map((name) => join(folder, name))
      .filter((file) => file !== first)
    expect(moved).toHaveLength(1)
    const request = { repository: repo, sessionPath: moved[0]! }
    const lost =
      `session ${sessionId} may have moved to another file, and pi could not say which: ` +
      'stop that session first'
    // Without the refusal, a second pi would start on the file this one writes.
    await expect(runtime.start(request)).rejects.toThrow(lost)
    await expect(runtime.remove(request)).rejects.toThrow(lost)
    // A new session's file is new, so nothing holds it up.
    await runtime.start({ repository: repo })
    return { sessionId, request, lost }
  }

  it('admits no resume or deletion while a moved pi cannot say which file it writes, until it stops', async () => {
    const { runtime } = boot()
    const { sessionId, request, lost } = await loseTrack(runtime, '/fake-clone-lose-state')
    // pi cannot answer get_state, so no prompt runs: stopping is what clears it here.
    const prompt = runtime.command(sessionId, { type: 'prompt', message: '/fake-find-file' })
    await expect(prompt).rejects.toThrow('Cannot verify the active pi model.')
    await expect(runtime.remove(request)).rejects.toThrow(lost)
    await runtime.stop(sessionId)
    // Nothing writes the file any more: it can be deleted.
    await runtime.remove(request)
    expect(existsSync(request.sessionPath)).toBe(false)
  })

  it('admits them again once a later answer names the file, and then knows it', async () => {
    const { runtime } = boot()
    const { sessionId, request } = await loseTrack(runtime, '/fake-clone-hide-file')
    const prompt = { type: 'prompt', message: '/fake-find-file' } as const
    expect(await runtime.command(sessionId, prompt)).toMatchObject({ success: true })
    await expect(runtime.start(request)).rejects.toThrow('the session is already running')
    await expect(runtime.remove(request)).rejects.toThrow('the session is running: stop it first')
    expect(existsSync(request.sessionPath)).toBe(true)
  })

  it('keeps a session running when its delivery throws, and logs why', async () => {
    const { runtime, log } = boot()
    const { sessionId } = await runtime.start({ repository: repo }, () => {
      throw new Error('the viewer went away')
    })
    expect((await runtime.command(sessionId, { type: 'get_state' })).success).toBe(true)
    await until(
      () => readFileSync(log.path()!, 'utf8').includes('"error":"the viewer went away"'),
      'the logged failure',
    )
    expect(runtime.list()).toHaveLength(1)
  })

  it('lets a turn in flight end and be saved before it stops pi', async () => {
    const { runtime } = boot()
    const sink = recorder()
    const { sessionId } = await runtime.start({ repository: repo }, sink.deliver)
    await runtime.command(sessionId, { type: 'prompt', message: 'stream a count' })
    await until(() => sink.events('message_update').length >= 3, 'a few deltas')
    const file = await sessionFile(runtime, sessionId)
    await runtime.stop(sessionId)
    expect(transcript(file).at(-1)).toMatchObject({
      message: { content: [{ text: expect.stringMatching(/^1 2 3 /) }], stopReason: 'aborted' },
    })
  })

  it('hides secrets from its log and from the pi stderr it delivers', async () => {
    const { runtime, log } = boot({ env: { FAKE_PI_LEAK: '1' } })
    const sink = recorder()
    await runtime.start({ repository: repo }, sink.deliver)
    const leak = await until(() => sink.stderr('cannot reach').at(0), 'the leak')
    expect(leak).toBe('cannot reach the provider with [redacted]')
    const logged = () => readFileSync(log.path()!, 'utf8')
    await until(() => logged().includes('cannot reach'), 'the logged line')
    expect(logged()).toContain('cannot reach the provider with [redacted]')
    expect(logged()).not.toContain(SECRET)
  })

  it('hides every line of a secret that spans lines, however short, as pi prints it', async () => {
    const key = 'q7Zx1\nK9wP2'
    const { runtime, log } = boot({ env: { FAKE_PI_LEAK: '1', ANTHROPIC_API_KEY: key } })
    const sink = recorder()
    await runtime.start({ repository: repo }, sink.deliver)
    // pi's stderr arrives one line at a time, so the key comes in two pieces.
    await until(() => sink.stderr('[redacted]').at(0), 'the second line')
    expect(sink.stderr('cannot reach')).toEqual(['cannot reach the provider with [redacted]'])
    const logged = () => readFileSync(log.path()!, 'utf8')
    await until(() => logged().includes('"text":"[redacted]"'), 'the logged lines')
    for (const line of key.split('\n')) expect(logged()).not.toContain(line)
  })

  it('takes no new work before it is ready or once it drains, and starts no pi for a bad request', async () => {
    const { runtime, log } = boot({ ready: false })
    const request = { repository: repo }
    await expect(runtime.start(request)).rejects.toThrow(
      'the Host is booting: it takes no new work',
    )
    runtime.life.to('validating')
    runtime.life.to('ready')
    const bad = { ...request, env: { NODE_OPTIONS: '--require=/x.js' }, model: '--extension=/x.ts' }
    await expect(runtime.start(bad)).rejects.toMatchObject({
      name: 'RequestError',
      errors: [
        { pointer: '/env', message: 'is set by the Host, never by a request' },
        { pointer: '/model', message: expect.any(String) },
      ],
    })
    expect(spawns(log)).toEqual([])
    await runtime.drain('finished')
    await expect(runtime.start(request)).rejects.toThrow(
      'the Host is stopped: it takes no new work',
    )
    await expect(runtime.remove({ ...request, sessionPath: '/s.jsonl' })).rejects.toThrow(
      'the Host is stopped',
    )
  })

  it('drains: ends turns in flight, stops every session and leaves no process', async () => {
    const { runtime } = boot()
    const sink = recorder()
    const idle = await runtime.start({ repository: repo })
    const busy = await runtime.start({ repository: repo }, sink.deliver)
    await runtime.command(busy.sessionId, { type: 'prompt', message: 'stream on' })
    await until(() => sink.events('message_update').length >= 2, 'deltas')
    const file = await sessionFile(runtime, busy.sessionId)
    expect(await runtime.drain('SIGTERM')).toEqual({
      state: 'stopped',
      reason: 'SIGTERM',
      sessions: 2,
      aborted: 1,
      unfinished: 0,
      forced: null,
      remaining: [],
      errors: [],
    })
    expect(runtime.life.state()).toBe('stopped')
    expect(isGone(idle.pid!) && isGone(busy.pid!)).toBe(true)
    expect(transcript(file).at(-1)).toMatchObject({ message: { stopReason: 'aborted' } })
  })

  it('kills a pi that ignores SIGTERM, and all of its group, once the grace period ends', async () => {
    const env = { FAKE_PI_IGNORE_TERM: '1', FAKE_PI_CHILD: '1' }
    const { runtime } = boot({ env, timings: { graceMs: 300 } })
    const sink = recorder()
    const { pid } = await runtime.start({ repository: repo }, sink.deliver)
    const child = Number(await until(() => sink.stderr('FAKE_PI_CHILD ').at(0)?.slice(14), 'child'))
    const started = Date.now()
    expect(await runtime.drain('SIGTERM')).toMatchObject({
      state: 'stopped',
      forced: null,
      remaining: [],
    })
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
    expect(isGone(pid!)).toBe(true)
    expect(() => process.kill(child, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
  })

  it('fails once the drain deadline passes, after killing every group', async () => {
    const env = { FAKE_PI_IGNORE_TERM: '1' }
    const { runtime } = boot({ env, timings: { graceMs: 30_000, deadlineMs: 400 } })
    const { pid } = await runtime.start({ repository: repo })
    const started = Date.now()
    expect(await runtime.drain('SIGTERM')).toMatchObject({
      state: 'failed',
      forced: 'deadline',
      remaining: [],
    })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(isGone(pid!)).toBe(true)
    expect(runtime.life.state()).toBe('failed')
  })

  it('takes reads and no new work while it drains, and kills at once on a second request', async () => {
    const env = { FAKE_PI_IGNORE_TERM: '1' }
    const { runtime } = boot({ env, timings: { graceMs: 60_000, deadlineMs: 60_000 } })
    const { sessionId, pid } = await runtime.start({ repository: repo })
    const first = runtime.drain('SIGTERM')
    // The first now waits out a grace period pi will never end on its own.
    await sleep(200)
    const more = runtime.command(sessionId, { type: 'prompt', message: 'more' })
    await expect(more).rejects.toThrow('New work cannot start')
    expect((await runtime.command(sessionId, { type: 'get_state' })).success).toBe(true)
    const hurried = Date.now()
    expect(runtime.drain('SIGINT')).toBe(first)
    expect(await first).toMatchObject({
      state: 'stopped',
      reason: 'SIGTERM',
      forced: 'hurried',
      remaining: [],
    })
    expect(Date.now() - hurried).toBeLessThan(5000)
    expect(isGone(pid!)).toBe(true)
  })
})

describe('a transcript deletion', () => {
  const folder = () => sessionDirForCwd(repo)
  const write = (path: string) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{}\n')
    return path
  }

  it("deletes a session file of pi's, and a file already gone is fine", async () => {
    const file = write(join(folder(), 'a.jsonl'))
    await unlinkTranscript(file)
    expect(existsSync(file)).toBe(false)
    await expect(unlinkTranscript(file)).resolves.toBeUndefined()
    await expect(unlinkTranscript(join(dir, 'gone/b.jsonl'))).resolves.toBeUndefined()
  })

  it.each([
    ['in the repository', () => write(join(repo, 'a.jsonl')), 'not a pi session'],
    [
      'in a folder inside a session folder',
      () => write(join(folder(), 'x/a.jsonl')),
      'not a pi session',
    ],
    ['not a .jsonl', () => write(join(folder(), 'a.txt')), 'not a pi session file'],
    [
      'a link to a session file',
      () => {
        const link = join(folder(), 'link.jsonl')
        symlinkSync(write(join(folder(), 'target.jsonl')), link)
        return link
      },
      'not a pi session file',
    ],
    [
      'a folder',
      () => {
        mkdirSync(join(folder(), 'b.jsonl'), { recursive: true })
        return join(folder(), 'b.jsonl')
      },
      'not a pi session file',
    ],
  ])('refuses a file %s, and leaves it', async (_what, make, message) => {
    mkdirSync(folder(), { recursive: true })
    const path = make()
    await expect(unlinkTranscript(path)).rejects.toThrow(message)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(join(folder(), 'target.jsonl')) || !path.endsWith('link.jsonl')).toBe(true)
  })

  it('refuses every file while pi has no session root', async () => {
    const file = write(join(repo, 'a.jsonl'))
    await expect(unlinkTranscript(file)).rejects.toThrow('not a pi session')
    expect(existsSync(file)).toBe(true)
  })
})

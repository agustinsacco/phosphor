import { afterEach, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const executable = resolve(import.meta.dirname, '../fake-pi.cjs')
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function fixture(env: Record<string, string> = {}, args = ['--mode', 'rpc']) {
  const root = await mkdtemp(join(tmpdir(), 'fake-commands-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const child = spawn(process.execPath, [executable, ...args], {
    cwd: root,
    env: { HOME: root, PI_CODING_AGENT_DIR: root, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  cleanup.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exit = new Promise<void>((done) => child.once('exit', () => done()))
    child.kill('SIGKILL')
    await exit
  })
  let output = ''
  let diagnostic = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (output += chunk))
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (diagnostic += chunk))
  const records = (): Record<string, unknown>[] =>
    output
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  let sequence = 0
  const send = (type: string, data = {}) => {
    const id = String(++sequence)
    child.stdin.write(JSON.stringify({ id, type, ...data }) + '\n')
    return id
  }
  const reply = async (id: string) => {
    await expect.poll(() => records().some((r) => r.id === id && r.type === 'response')).toBe(true)
    return records().find((r) => r.id === id && r.type === 'response')!
  }
  const request = (type: string, data = {}) => reply(send(type, data))
  const settled = (count: number) =>
    expect.poll(() => records().filter((r) => r.type === 'agent_settled').length).toBe(count)
  return { root, child, records, send, reply, request, settled, diagnostic: () => diagnostic }
}

it('never answers a silent command while continuing to dispatch other commands', async () => {
  const h = await fixture({ PI_FAKE_SILENT: 'get_state' })
  const id = h.send('get_state')
  await h.request('get_messages')
  expect(h.records().some((r) => r.id === id)).toBe(false)
})

it.each(['reply', 'state'])('holds a clone %s until its release file exists', async (mode) => {
  const h = await fixture()
  const initial = await h.request('get_state')
  const release = join(h.root, 'release')
  const cloneId = h.send('prompt', { message: `/fake-clone-hold-${mode} ${release}` })
  if (mode === 'state') await h.reply(cloneId)
  const heldId = mode === 'state' ? h.send('get_state') : cloneId
  await expect.poll(() => readFile(`${release}.held`, 'utf8')).toBe('')
  expect(h.records().some((r) => r.id === heldId)).toBe(false)
  await writeFile(release, '')
  await h.reply(heldId)
  const moved = await h.request('get_state')
  expect(moved.data).not.toEqual(initial.data)
  expect(moved).toMatchObject({ data: { messageCount: 0 } })
})

it('clones before extension failure and loses or hides state until explicitly found', async () => {
  const h = await fixture()
  const initial = await h.request('get_state')
  expect(await h.request('prompt', { message: '/fake-clone-fails' })).toMatchObject({
    success: false,
    error: 'the extension failed',
  })
  expect((await h.request('get_state')).data).not.toEqual(initial.data)
  await h.request('prompt', { message: '/fake-clone-lose-state' })
  expect(await h.request('get_state')).toMatchObject({
    success: false,
    error: 'cannot read the session',
  })
  await h.request('prompt', { message: '/fake-clone-hide-file' })
  const hidden = await h.request('get_state')
  expect(hidden).toMatchObject({ success: true })
  expect(hidden.data).not.toHaveProperty('sessionFile')
  await h.request('prompt', { message: '/fake-find-file' })
  expect(await h.request('get_state')).toMatchObject({ data: { sessionFile: expect.any(String) } })
  await h.request('prompt', { message: '/fake-clone' })
  expect(await h.request('get_messages')).toMatchObject({ data: { messages: [] } })
})

it('round trips a dialog without acknowledging the original prompt early', async () => {
  const h = await fixture()
  const id = h.send('prompt', { message: '/fake-ask' })
  await expect.poll(() => h.records().some((r) => r.method === 'confirm')).toBe(true)
  const dialog = h.records().find((r) => r.method === 'confirm')!
  expect(dialog).toMatchObject({ title: 'Allow?', message: 'The fake asks' })
  expect(h.records().some((r) => r.id === id)).toBe(false)
  h.child.stdin.write(
    JSON.stringify({ type: 'extension_ui_response', id: dialog.id, confirmed: true }) + '\n',
  )
  expect(await h.reply(id)).toMatchObject({ success: true })
  await expect.poll(h.diagnostic).toContain('FAKE_PI_DIALOG {"confirmed":true}')
  expect(h.records().some((r) => r.type === 'agent_start')).toBe(false)
})

it('drains prompt, steer and follow-up queues in insertion order after abort', async () => {
  const h = await fixture()
  await h.request('prompt', { message: 'stream' })
  await h.request('prompt', { message: 'PHX-prompt', streamingBehavior: 'steer' })
  await h.request('steer', { message: 'PHX-steer' })
  await h.request('follow_up', { message: 'PHX-follow' })
  expect(await h.request('get_state')).toMatchObject({
    data: { pendingMessageCount: 3, isStreaming: true },
  })
  expect(h.records()).toContainEqual({
    type: 'queue_update',
    steering: ['PHX-prompt', 'PHX-steer'],
    followUp: ['PHX-follow'],
  })
  await h.request('abort')
  await h.settled(4)
  expect(await h.request('get_messages')).toMatchObject({
    data: {
      messages: [
        { role: 'user', content: 'stream' },
        { stopReason: 'aborted' },
        { role: 'user', content: 'PHX-prompt' },
        { stopReason: 'stop' },
        { role: 'user', content: 'PHX-steer' },
        { stopReason: 'stop' },
        { role: 'user', content: 'PHX-follow' },
        { stopReason: 'stop' },
      ],
    },
  })
  expect(h.records().at(-1)).toMatchObject({ type: 'response' })
})

it('refuses provider-only RPC launches before startup diagnostics', async () => {
  const h = await fixture({}, ['--mode', 'rpc', '--provider', 'anthropic'])
  await expect.poll(() => h.child.exitCode).toBe(1)
  expect(h.diagnostic()).toBe('--provider requires --model\n')
  expect(h.records()).toEqual([])
})

it('lists extension commands, models and thinking levels and preserves compaction event order', async () => {
  const h = await fixture({}, ['--mode', 'rpc', '-e', '/fixture/context-breakdown.ts'])
  expect(await h.request('get_commands')).toMatchObject({
    data: {
      commands: [
        { name: 'phosphor-context-budget', source: 'extension' },
        { name: 'host-only', source: 'extension' },
      ],
    },
  })
  expect(h.records()[0]).toMatchObject({
    statusKey: 'phosphor-context-breakdown',
    statusText: '{"components":[]}',
  })
  expect(await h.request('get_available_models')).toMatchObject({
    data: {
      models: [
        { provider: 'fake', id: 'fake-model' },
        { provider: 'anthropic', id: 'host-reasoner' },
      ],
    },
  })
  expect(await h.request('get_available_thinking_levels')).toMatchObject({
    data: { levels: ['off'] },
  })
  await h.request('set_model', { provider: 'anthropic', modelId: 'host-reasoner' })
  await h.request('set_thinking_level', { level: 'high' })
  expect(await h.request('get_available_thinking_levels')).toMatchObject({
    data: { levels: ['off', 'low', 'medium', 'high'] },
  })
  expect(await h.request('get_state')).toMatchObject({ data: { thinkingLevel: 'high' } })
  await h.request('prompt', { message: '/phosphor-context-budget 100000' })
  await h.request('prompt', { message: '/host-only' })
  expect(h.records().some((r) => r.type === 'agent_start')).toBe(false)
  await h.request('compact')
  expect(
    h
      .records()
      .slice(-3)
      .map((r) => r.type),
  ).toEqual(['compaction_start', 'response', 'compaction_end'])
  expect(h.records().at(-1)).toMatchObject({
    reason: 'manual',
    aborted: false,
    result: { summary: 'HOST_A_ONLY compacted' },
  })
})

it.each(['status', 'budget'])('honors the hidden %s startup mode', async (mode) => {
  const h = await fixture({ FAKE_PI_HIDE: mode }, [
    '--mode',
    'rpc',
    '-e',
    '/fixture/context-breakdown.ts',
  ])
  const commands = await h.request('get_commands')
  expect(h.records().some((r) => r.statusKey === 'phosphor-context-breakdown')).toBe(
    mode !== 'status',
  )
  expect(commands).toMatchObject({ data: { commands: mode === 'budget' ? [] : expect.any(Array) } })
})

it.each(['wrong', 'fail', 'exit'])('preserves the %s turn mode', async (mode) => {
  const h = await fixture({ FAKE_PI_TURN: mode, ANTHROPIC_API_KEY: 'fixture-secret' })
  await h.request('prompt', { message: 'PHX-token' })
  if (mode === 'exit') {
    await expect.poll(() => h.child.exitCode).toBe(3)
    expect(h.records().some((r) => r.type === 'agent_end')).toBe(false)
    return
  }
  await h.settled(1)
  expect(await h.request('get_last_assistant_text')).toMatchObject({
    data: { text: mode === 'wrong' ? 'ok' : '' },
  })
  if (mode === 'fail')
    expect(JSON.stringify(h.records())).toContain('401: invalid x-api-key fixture-secret')
})

it('forgets recall tokens only when configured', async () => {
  const h = await fixture({ FAKE_PI_FORGET: '1' })
  await h.request('prompt', { message: 'PHX-token' })
  await h.settled(1)
  await h.request('prompt', { message: 'recall' })
  await h.settled(2)
  expect(await h.request('get_last_assistant_text')).toMatchObject({ data: { text: 'ok' } })
})

it('stalls ordinary prompts and writes its pid until aborted', async () => {
  const h = await fixture()
  const marker = join(h.root, 'stall')
  const stalled = await fixture({ FAKE_PI_STALL: marker })
  await stalled.request('prompt', { message: 'ordinary' })
  await expect.poll(() => readFile(marker, 'utf8')).toBe(String(stalled.child.pid))
  expect(await stalled.request('get_state')).toMatchObject({ data: { isStreaming: true } })
  await stalled.request('abort')
  await stalled.settled(1)
})

it('prints diagnostic environment and leak and ignores SIGTERM when configured', async () => {
  const h = await fixture({
    FAKE_PI_IGNORE_TERM: '1',
    FAKE_PI_LEAK: '1',
    ANTHROPIC_API_KEY: 'fixture-secret',
  })
  await h.request('get_state')
  expect(h.diagnostic()).toContain('FAKE_PI_ENV ')
  expect(h.diagnostic()).toContain('FAKE_PI_PATH ')
  expect(h.diagnostic()).toContain('cannot reach the provider with fixture-secret')
  h.child.kill('SIGTERM')
  await h.request('get_messages')
  expect(h.child.exitCode).toBeNull()
})

it('starts same-group and escaped children with the documented pid diagnostics', async () => {
  const h = await fixture()
  const marker = join(h.root, 'escaped')
  const children = await fixture({ FAKE_PI_CHILD: '1', FAKE_PI_ESCAPE: marker })
  await children.request('get_state')
  const grouped = Number(/FAKE_PI_CHILD (\d+)/.exec(children.diagnostic())?.[1])
  const escaped = Number(await readFile(marker, 'utf8'))
  for (const pid of [grouped, escaped]) {
    expect(pid).toBeGreaterThan(0)
    cleanup.push(async () => {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // The child may already have exited during cleanup.
      }
    })
    expect(() => process.kill(pid, 0)).not.toThrow()
  }
  children.child.kill('SIGTERM')
  await expect.poll(() => children.child.exitCode).toBe(0)
  expect(() => process.kill(escaped, 0)).not.toThrow()
})

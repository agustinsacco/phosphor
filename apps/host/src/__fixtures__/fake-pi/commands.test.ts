import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDispatcher } from './commands.cjs'
import { createSession, persist } from './persistence.cjs'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(env = {}) {
  const root = mkdtempSync(join(tmpdir(), 'fake-dispatch-'))
  roots.push(root)
  const session = createSession({
    sessionFile: undefined,
    folder: root,
    cwd: root,
    launchName: undefined,
  })
  const trace: unknown[] = []
  const turns = { state: { streaming: false }, prompt: vi.fn(), enqueue: vi.fn(), abort: vi.fn() }
  const models = [{ provider: 'fake', id: 'reasoner', reasoning: true }]
  const handle = createDispatcher(
    {
      session,
      turns,
      models,
      agentDir: root,
      breakdown: true,
      initialState: () => ({
        model: models[0],
        thinkingLevel: 'off',
        sessionFile: session.sessionFile,
      }),
      out: (record: unknown) => trace.push(record),
      respond: (cmd: unknown, data: unknown) => trace.push({ cmd, data }),
      fail: (cmd: unknown, error: unknown) => trace.push({ cmd, error }),
    },
    env,
  )
  const send = (type: string, data = {}) => handle({ type, id: 'request', ...data })
  return { root, session, trace, turns, send }
}

it('dispatches reads, retry, naming, known and unknown model selection and thinking', () => {
  const h = fixture()
  h.send('get_last_assistant_text')
  expect(h.trace.at(-1)).toMatchObject({ data: { text: null } })
  persist(h.session, { role: 'user', content: 'hello' })
  persist(h.session, { role: 'assistant', content: [{ text: 'one' }, { text: 'two' }] })
  h.send('get_messages')
  expect(h.trace.at(-1)).toMatchObject({ data: { messages: h.session.messages } })
  h.send('get_last_assistant_text')
  expect(h.trace.at(-1)).toMatchObject({ data: { text: 'onetwo' } })
  h.send('get_session_stats')
  expect(h.trace.at(-1)).toMatchObject({
    data: {
      sessionId: h.session.id,
      sessionFile: h.session.sessionFile,
      userMessages: 1,
      assistantMessages: 1,
      totalMessages: 2,
      toolCalls: 0,
      toolResults: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    },
  })
  h.send('set_auto_retry', { enabled: false })
  expect(h.trace.at(-1)).toMatchObject({ data: { enabled: false } })
  h.send('set_session_name', { name: 'named' })
  expect(readFileSync(h.session.sessionFile, 'utf8')).toContain('"name":"named"')
  h.send('set_model', { provider: 'fake', modelId: 'reasoner' })
  expect(h.trace.at(-1)).toMatchObject({ data: { reasoning: true } })
  h.send('get_available_thinking_levels')
  expect(h.trace.at(-1)).toMatchObject({ data: { levels: ['off', 'low', 'medium', 'high'] } })
  h.send('set_model', { provider: 'custom', modelId: 'unlisted' })
  h.send('set_thinking_level', { level: 'high' })
  h.send('get_state')
  expect(h.trace.at(-1)).toMatchObject({
    data: {
      model: { provider: 'custom', id: 'unlisted', contextWindow: 200000 },
      thinkingLevel: 'high',
    },
  })
  h.send('get_available_thinking_levels')
  expect(h.trace.at(-1)).toMatchObject({ data: { levels: ['off'] } })
  h.send('get_available_models')
  expect(h.trace.at(-1)).toMatchObject({ data: { models: [{ id: 'reasoner' }] } })
  h.send('unsupported')
  expect(h.trace.at(-1)).toMatchObject({ error: 'unsupported in fake' })
})

it('acknowledges prompts before turning, routes queues and aborts, and suppresses silent dispatch', () => {
  const h = fixture()
  const images = [{ type: 'image', data: 'fixture' }]
  h.send('prompt', { message: 'hello', images })
  expect(h.turns.prompt).toHaveBeenCalledWith('hello', images)
  expect(h.trace[0]).toMatchObject({ cmd: { type: 'prompt' } })
  h.turns.state.streaming = true
  h.send('prompt', { message: 'queued' })
  h.send('prompt', { message: 'steering', streamingBehavior: 'steer' })
  h.send('steer', { message: 'explicit steer' })
  h.send('follow_up', { message: 'explicit follow' })
  expect(h.turns.enqueue.mock.calls).toEqual([
    ['queued', 'followUp'],
    ['steering', 'steer'],
    ['explicit steer', 'steer'],
    ['explicit follow', 'followUp'],
  ])
  h.send('abort')
  expect(h.turns.abort).toHaveBeenCalledOnce()
  const silent = fixture({ PI_FAKE_SILENT: 'abort' })
  silent.send('abort')
  expect(silent.trace).toEqual([])
  expect(silent.turns.abort).not.toHaveBeenCalled()
})

it.each(['/fake-clone', '/fake-clone-fails', '/fake-clone-lose-state', '/fake-clone-hide-file'])(
  'handles extension prompt %s without starting a turn',
  (message) => {
    const h = fixture()
    const original = h.session.sessionFile
    h.send('prompt', { message })
    expect(h.session.sessionFile).not.toBe(original)
    expect(h.turns.prompt).not.toHaveBeenCalled()
    h.send('get_state')
    if (message.endsWith('lose-state'))
      expect(h.trace.at(-1)).toMatchObject({ error: 'cannot read the session' })
    if (message.endsWith('hide-file'))
      expect(h.trace.at(-1)).toMatchObject({ data: { sessionFile: undefined } })
    h.send('prompt', { message: '/fake-find-file' })
    h.send('get_state')
    expect(h.trace.at(-1)).toMatchObject({ data: { sessionFile: h.session.sessionFile } })
  },
)

it.each(['reply', 'state'])('releases a held clone %s exactly once', (mode) => {
  vi.useFakeTimers()
  const h = fixture()
  const release = join(h.root, 'release')
  h.send('prompt', { message: `/fake-clone-hold-${mode} ${release}` })
  if (mode === 'state') h.send('get_state')
  expect(readFileSync(`${release}.held`, 'utf8')).toBe('')
  const before = h.trace.length
  vi.advanceTimersByTime(30)
  expect(h.trace).toHaveLength(before)
  writeFileSync(release, '')
  vi.advanceTimersByTime(30)
  expect(h.trace).toHaveLength(before + 1)
})

it('handles notifications, budget commands and dialogs without model turns', () => {
  const h = fixture()
  h.send('prompt', { message: '/host-only' })
  expect(h.trace.at(-1)).toMatchObject({ method: 'notify', message: 'HOST_A_ONLY command handled' })
  h.send('prompt', { message: '/phosphor-context-budget 50000' })
  h.send('prompt', { message: '/fake-ask' })
  const dialog = h.trace.at(-1) as { id: string }
  expect(dialog).toMatchObject({ method: 'confirm', title: 'Allow?' })
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  h.send('extension_ui_response', { id: dialog.id, confirmed: false })
  h.send('extension_ui_response', { id: dialog.id, confirmed: true })
  expect(log).toHaveBeenCalledExactlyOnceWith('FAKE_PI_DIALOG {"confirmed":false}')
  expect(h.turns.prompt).not.toHaveBeenCalled()
  h.send('get_commands')
  expect(h.trace.at(-1)).toMatchObject({
    data: { commands: [{ name: 'phosphor-context-budget' }, { name: 'host-only' }] },
  })
  h.send('compact')
  expect(h.trace.slice(-3)).toMatchObject([
    { type: 'compaction_start', reason: 'manual' },
    { data: { summary: 'HOST_A_ONLY compacted' } },
    { type: 'compaction_end', reason: 'manual', aborted: false },
  ])
})

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCurator } from '@phosphor/brain-runtime/agent/curator'
import type { CuratorContext } from '@phosphor/brain-runtime/agent/curator-context'
import { BRAIN_TURN_REFUSAL } from '@phosphor/brain-runtime/agent/curator-turn'
import type { ExtensionUIRequest } from '@phosphor/shared/rpc'
import { createBrainSurfaceHandlers } from '../surface-service'
import {
  person,
  setupConversation,
  started,
  type ConversationSetup,
} from './__fixtures__/conversation-setup'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-brain-turns-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const question = (id: string): ExtensionUIRequest => ({
  type: 'extension_ui_request',
  id,
  method: 'confirm',
  title: 'Merge Harbor records?',
  message: 'Harbor and Harbor Ltd look the same.',
})
const yes = (id: string) => ({ type: 'extension_ui_response', id, confirmed: true }) as const

/** Rina's message, running, and the page she saw while it ran. */
async function rinaTurn(s: ConversationSetup, rina = person('Rina Okafor'), fence = 1) {
  expect(await s.surface.send('Who owns Harbor?', fence, rina.caller)).toBe('ok')
  await started(s)
  return { rina, seen: await s.surface.show(null, rina.caller) }
}

async function defragTurn(s: ConversationSetup) {
  const info = await s.conversation.lane.open({ name: 'Brain' })
  expect(
    await s.conversation.lane.command(info.sessionId, { type: 'prompt', message: 'Defrag.' }),
  ).toMatchObject({ success: true })
  await started(s)
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((release) => {
    resolve = release
  })
  return { promise, resolve }
}

/** Holds abort before the service can write to pi, without holding other RPCs. */
function pauseAbort(s: ConversationSetup) {
  const abort = deferred<void>()
  const sent = deferred<void>()
  const command = s.reserved.command.bind(s.reserved)
  const spy = vi.spyOn(s.reserved, 'command').mockImplementation(async (...args) => {
    if (args[1].type === 'abort') {
      sent.resolve()
      await abort.promise
    }
    return command(...args)
  })
  return { entered: sent.promise, release: abort.resolve, restore: () => spy.mockRestore() }
}

describe('Stop', () => {
  it('stops the controller turn the client observed', async () => {
    const s = setupConversation(dir)
    const { rina, seen } = await rinaTurn(s)
    expect(seen.turn).toEqual(expect.any(String))
    expect(await s.surface.stop(seen.fence, seen.turn!, rina.caller)).toBe('ok')
    expect(s.aborts()).toHaveLength(1)
  })

  it('refuses an in-flight curator write even before pi receives Stop', async () => {
    const s = setupConversation(dir)
    const { rina, seen } = await rinaTurn(s)
    const pause = pauseAbort(s)
    const handlers = createBrainSurfaceHandlers({
      runtime: { api: { status: async () => ({ prefs: { enabled: true } }) } } as Parameters<
        typeof createBrainSurfaceHandlers
      >[0]['runtime'],
      lanes: { lane: () => undefined, source: () => undefined },
      agent: s.surface,
    })
    const embedding = deferred<number[][]>()
    const correct = vi.fn(() => ({ operationId: 'ledger', carried: [], ended: [] }))
    const curator = createCurator({
      store: { correct },
      search: { refresh: async () => {} },
      queue: { kick: () => {} },
      changed: () => {},
      defrag: { turnRun: () => null },
      options: {
        agent: { turnGate: s.conversation.turnGate },
        embeddings: { embed: () => embedding.promise },
      },
      enabled: () => true,
    } as unknown as CuratorContext)
    const mutation = curator.correct(
      {
        memoryId: 'ledger',
        summary: 'Tom Lee owns Ledger.',
        source: 'Ledger',
        quote: 'Tom Lee takes over.',
        reason: 'Correct the recorded owner.',
      },
      new AbortController().signal,
    )
    const stopped = handlers['brain:laneStop'](
      { method: 'brain:laneStop', args: [seen.fence, seen.turn!] },
      rina.caller,
    )
    try {
      await pause.entered
      embedding.resolve([[1]])
      expect(await mutation).toMatchObject({ status: 'refused', message: BRAIN_TURN_REFUSAL })
      expect(correct).not.toHaveBeenCalled()
    } finally {
      pause.release()
      await stopped
      pause.restore()
    }
    expect(await stopped).toMatchObject({ status: 'ok' })
  })

  it('refuses a stale turn reference without aborting a later turn on the same fence', async () => {
    const s = setupConversation(dir)
    const { rina, seen } = await rinaTurn(s)
    s.finish()
    expect(await s.surface.send('And Ledger?', seen.fence, rina.caller)).toBe('ok')
    await started(s)
    expect(await s.surface.stop(seen.fence, seen.turn!, rina.caller)).toBe('stale')
    expect(await s.surface.stop(seen.fence, 'unknown-turn', rina.caller)).toBe('stale')
    expect(s.aborts()).toEqual([])
  })

  it('refuses a delayed abort once a later turn starts on the same process', async () => {
    const s = setupConversation(dir)
    const { rina, seen } = await rinaTurn(s)
    const pause = pauseAbort(s)
    const stopped = s.surface.stop(seen.fence, seen.turn!, rina.caller)
    try {
      await pause.entered
      s.finish()
      expect(await s.surface.send('And Ledger?', seen.fence, rina.caller)).toBe('ok')
      await started(s)
    } finally {
      pause.release()
      await stopped
      pause.restore()
    }
    expect(await stopped).toBe('stale')
    expect(s.aborts()).toEqual([])
    expect(await s.surface.show(null, rina.caller)).toMatchObject({ running: true })
  })

  it('never stops a Defrag turn, which shows no turn reference', async () => {
    const s = setupConversation(dir)
    const rina = person('Rina Okafor')
    const fence = (await s.surface.show(null, rina.caller)).fence
    expect(await s.surface.take(fence, rina.caller)).toBe('ok')
    await defragTurn(s)
    const seen = await s.surface.show(null, rina.caller)
    expect(seen).toMatchObject({ running: true, turn: null })
    expect(await s.surface.stop(seen.fence, 'any-turn', rina.caller)).toBe('stale')
    expect(s.aborts()).toEqual([])
  })

  it('stops only the caller’s own turn, not one another person started', async () => {
    const s = setupConversation(dir)
    const { seen } = await rinaTurn(s)
    const tom = person('Tom Lee')
    expect(await s.surface.take(seen.fence, tom.caller)).toBe('ok')
    expect(await s.surface.stop(seen.fence + 1, seen.turn!, tom.caller)).toBe('not-controller')
    expect(s.aborts()).toEqual([])
  })
})

describe('Answer', () => {
  it('answers a question once, from the turn that asked it, by that turn’s controller', async () => {
    const s = setupConversation(dir)
    const { rina } = await rinaTurn(s)
    s.ask(question('q-harbor'))
    const seen = await s.surface.show(null, rina.caller)
    expect(seen.dialogs.map(({ id }) => id)).toEqual(['q-harbor'])
    expect(await s.surface.answer(yes('q-harbor'), seen.fence, rina.caller)).toBe('ok')
    expect(await s.surface.answer(yes('q-harbor'), seen.fence, rina.caller)).toBe('not-found')
    expect(s.responses).toHaveLength(1)
  })

  it('refuses a question from an earlier turn once a later turn runs on the same fence', async () => {
    const s = setupConversation(dir)
    const { rina } = await rinaTurn(s)
    s.ask(question('q-earlier'))
    const seen = await s.surface.show(null, rina.caller)
    s.finish()
    expect(await s.surface.send('And Ledger?', seen.fence, rina.caller)).toBe('ok')
    await started(s)
    expect((await s.surface.show(null, rina.caller)).dialogs).toEqual([])
    expect(await s.surface.answer(yes('q-earlier'), seen.fence, rina.caller)).toBe('not-found')
    expect(s.responses).toEqual([])
  })

  it('never answers a Defrag question through an interactive controller', async () => {
    const s = setupConversation(dir)
    const rina = person('Rina Okafor')
    const fence = (await s.surface.show(null, rina.caller)).fence
    expect(await s.surface.take(fence, rina.caller)).toBe('ok')
    await defragTurn(s)
    s.ask(question('q-defrag'))
    const seen = await s.surface.show(null, rina.caller)
    expect(seen.dialogs).toEqual([])
    expect(await s.surface.answer(yes('q-defrag'), seen.fence, rina.caller)).toBe('not-found')
    expect(s.responses).toEqual([])
  })

  it('does not let a new controller answer the question of a turn it did not start', async () => {
    const s = setupConversation(dir)
    const { rina } = await rinaTurn(s)
    s.ask(question('q-rina'))
    const seen = await s.surface.show(null, rina.caller)
    const tom = person('Tom Lee')
    expect(await s.surface.take(seen.fence, tom.caller)).toBe('ok')
    expect((await s.surface.show(null, tom.caller)).dialogs).toEqual([])
    expect(await s.surface.answer(yes('q-rina'), seen.fence + 1, tom.caller)).toBe('not-found')
    expect(await s.surface.answer(yes('q-rina'), seen.fence, rina.caller)).toBe('not-controller')
    expect(s.responses).toEqual([])
  })

  it('never answers a question from a replaced process on its successor', async () => {
    const s = setupConversation(dir)
    const { rina } = await rinaTurn(s)
    s.ask(question('q-replaced'))
    const seen = await s.surface.show(null, rina.caller)
    // The first process dies without its exit reaching the conversation yet.
    s.processes[0]!.alive = false
    expect(await s.surface.send('Who owns Kestrel?', seen.fence, rina.caller)).toBe('ok')
    await started(s)
    expect(await s.surface.answer(yes('q-replaced'), seen.fence, rina.caller)).toBe('not-found')
    expect(s.responses).toEqual([])
  })
})

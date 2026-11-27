import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBrainAgentBinding } from './binding'
import { person, setupConversation, started } from './__fixtures__/conversation-setup'

vi.mock(import('node:fs/promises'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, writeFile: vi.fn(actual.writeFile) }
})

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-brain-control-'))
})
afterEach(() => {
  vi.mocked(writeFile).mockReset()
  rmSync(dir, { recursive: true, force: true })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => (resolve = done))
  return { promise, resolve }
}

/** Pauses the next binding write after staging bytes but before replacing the binding. */
async function whileStaged<T>(act: () => Promise<T>, whilePending: () => Promise<void>) {
  const actualWrite = vi.mocked(writeFile).getMockImplementation()!
  const staged = deferred()
  const resume = deferred()
  vi.mocked(writeFile).mockImplementationOnce(async (...args) => {
    await actualWrite(...args)
    staged.resolve()
    await resume.promise
  })
  const acting = act()
  try {
    await staged.promise
    await whilePending()
  } finally {
    resume.resolve()
    await acting
  }
  return acting
}

it('does not transfer or fence out the running turn’s owner when Take is revoked during binding I/O', async () => {
  const s = setupConversation(dir)
  const owner = person('Rina Okafor')
  const taker = person('Tom Lee')
  expect(await s.surface.send('Who owns Harbor?', 1, owner.caller)).toBe('ok')
  await started(s)
  s.ask({
    type: 'extension_ui_request',
    id: 'harbor',
    method: 'confirm',
    title: 'Merge Harbor?',
    message: 'Harbor and Harbor Ltd look the same.',
  })
  const seen = await s.surface.show(null, owner.caller)
  expect(seen.turn).toEqual(expect.any(String))
  const answer = { type: 'extension_ui_response', id: 'harbor', confirmed: true } as const
  const disk = () => createBrainAgentBinding(s.bindingFile).read()
  const before = await disk()

  const result = await whileStaged(
    () => s.surface.take(seen.fence, taker.caller),
    async () => {
      expect(await disk()).toEqual(before)
      taker.authority.allowed = false
    },
  )

  expect(result).toBe('unavailable')
  expect(await disk()).toEqual(before)
  expect(existsSync(`${s.bindingFile}.${process.pid}.tmp`)).toBe(false)
  expect(await s.surface.show(null, owner.caller)).toMatchObject({
    controller: seen.controller,
    fence: seen.fence,
    turn: seen.turn,
    running: true,
  })
  expect(s.conversation.turnGate()?.admit()).toBe(true)
  expect(s.aborts()).toEqual([])

  // A valid retake fences off the old page without renaming or ending the same turn.
  expect(await s.surface.take(seen.fence, owner.caller)).toBe('ok')
  expect((await disk()).fence).toBe(seen.fence + 1)
  expect(await s.surface.show(null, owner.caller)).toMatchObject({
    controller: seen.controller,
    fence: seen.fence + 1,
    turn: seen.turn,
    running: true,
  })
  expect(await s.surface.answer(answer, seen.fence, owner.caller)).toBe('not-controller')
  expect(await s.surface.stop(seen.fence, seen.turn!, owner.caller)).toBe('not-controller')
  expect(s.responses).toEqual([])
  expect(s.aborts()).toEqual([])
  expect(await s.surface.answer(answer, seen.fence + 1, owner.caller)).toBe('ok')
  expect(await s.surface.stop(seen.fence + 1, seen.turn!, owner.caller)).toBe('ok')
})

it('leaves a free lane unclaimed at its original fence when Send is revoked during binding I/O', async () => {
  const s = setupConversation(dir)
  const sender = person('Rina Okafor')
  const next = person('Tom Lee')
  const seen = await s.surface.show(null, sender.caller)
  const disk = () => createBrainAgentBinding(s.bindingFile).read()
  const before = await disk()

  const result = await whileStaged(
    () => s.surface.send('Who owns Harbor?', seen.fence, sender.caller),
    async () => {
      expect(await disk()).toEqual(before)
      sender.authority.allowed = false
    },
  )

  expect(result).toBe('unavailable')
  expect(await disk()).toEqual(before)
  expect(existsSync(`${s.bindingFile}.${process.pid}.tmp`)).toBe(false)
  expect(await s.surface.show(null, next.caller)).toMatchObject({
    controller: null,
    fence: seen.fence,
    turn: null,
  })
  expect(s.processes).toEqual([])
  expect(s.prompts()).toEqual([])

  expect(await s.surface.send('Who owns Ledger?', seen.fence, next.caller)).toBe('ok')
  await started(s)
  expect((await disk()).fence).toBe(seen.fence + 1)
  expect(await s.surface.show(null, next.caller)).toMatchObject({
    controller: { clientId: next.caller.client.id },
    fence: seen.fence + 1,
    running: true,
  })
  expect(s.prompts()).toHaveLength(1)
  s.finish()
})

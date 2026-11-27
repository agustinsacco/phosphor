import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { person, setupConversation, started } from './__fixtures__/conversation-setup'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-brain-characterize-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

it('runs Tell without taking control, and refuses it from anyone but the controller', async () => {
  const s = setupConversation(dir)
  const rina = person('Rina Okafor')
  const tom = person('Tom Lee')
  expect(await s.surface.tell('Tom Lee leads Ledger', rina.caller)).toBe('ok')
  await started(s)
  expect(await s.surface.show(null, rina.caller)).toMatchObject({ controller: null, fence: 1 })
  s.finish()
  expect(await s.surface.take(1, tom.caller)).toBe('ok')
  expect(await s.surface.tell('Mara Voss leads Kestrel', rina.caller)).toBe('not-controller')
  expect(s.prompts()).toHaveLength(1)
})

it('fences control: Take advances the fence and an older page acts on nothing', async () => {
  const s = setupConversation(dir)
  const rina = person('Rina Okafor')
  const tom = person('Tom Lee')
  expect(await s.surface.take(2, rina.caller)).toBe('not-controller')
  expect(await s.surface.take(1, rina.caller)).toBe('ok')
  expect(await s.surface.take(2, tom.caller)).toBe('ok')
  expect(await s.surface.send('Who owns Harbor?', 2, rina.caller)).toBe('not-controller')
  expect(await s.surface.send('Who owns Harbor?', 3, rina.caller)).toBe('not-controller')
  expect(await s.surface.show(null, rina.caller)).toMatchObject({
    controller: { clientId: tom.caller.client.id, label: 'Tom Lee' },
    fence: 3,
  })
})

it('answers busy to a person while Defrag holds the lane, and never restarts it under Defrag', async () => {
  const s = setupConversation(dir)
  const rina = person('Rina Okafor')
  let release!: () => void
  const holding = s.conversation.lane.hold(new AbortController().signal, async () => {
    await s.conversation.lane.open({ name: 'Brain' })
    await new Promise<void>((resolve) => (release = resolve))
  })
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(await s.surface.send('Who owns Ledger?', 1, rina.caller)).toBe('busy')
  expect(s.processes.map((p) => [p.profile, p.alive])).toEqual([['defrag', true]])
  release()
  await holding
  // The busy Send still claimed the free lane, so Rina's next message goes at the new fence.
  expect(await s.surface.send('Who owns Ledger?', 2, rina.caller)).toBe('ok')
})

it('shows the reply in flight under its turn, and drops it once the turn settles', async () => {
  const s = setupConversation(dir)
  const rina = person('Rina Okafor')
  expect(await s.surface.send('Who owns Northwind?', 1, rina.caller)).toBe('ok')
  await started(s)
  s.emit({
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta: 'Mara Voss' },
  })
  expect((await s.surface.show(null, rina.caller)).entries).toEqual([
    { id: 't1', role: 'assistant', text: 'Mara Voss' },
  ])
  s.finish()
  expect((await s.surface.show(null, rina.caller)).entries).toEqual([])
})

it('passes Defrag’s other commands through, and refuses its prompt in the interactive profile', async () => {
  const s = setupConversation(dir)
  const rina = person('Rina Okafor')
  expect(await s.surface.send('Who owns Harbor?', 1, rina.caller)).toBe('ok')
  await started(s)
  s.finish()
  const live = s.processes.at(-1)!.id
  expect(await s.conversation.lane.command(live, { type: 'get_state' })).toMatchObject({
    success: true,
  })
  expect(
    await s.conversation.lane.command(live, { type: 'prompt', message: 'Defrag.' }),
  ).toMatchObject({ success: false })
})

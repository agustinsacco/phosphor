import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  person,
  setupConversation,
  started,
  type ConversationSetupOptions,
} from './__fixtures__/conversation-setup'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-brain-conversation-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const setup = (options: ConversationSetupOptions = {}) => setupConversation(dir, options)

describe('the qualified interactive launch', () => {
  it('refuses Send and Tell with no qualified launch before pi starts, control changes or the transcript binds', async () => {
    const s = setup({ qualified: null })
    const rina = person('Rina Okafor')
    expect(await s.surface.send('Who owns Harbor?', 1, rina.caller)).toBe('unavailable')
    expect(await s.surface.tell('Tom Lee leads Ledger', rina.caller)).toBe('unavailable')
    expect(s.processes).toEqual([])
    expect(existsSync(s.bindingFile)).toBe(false)
    expect(await s.surface.show(null, rina.caller)).toMatchObject({
      controller: null,
      fence: 1,
      running: false,
      turn: null,
      messaging: false,
      entries: [],
    })
  })

  it('says on the page whether a message can run', async () => {
    const rina = person('Rina Okafor')
    expect(await setup().surface.show(null, rina.caller)).toMatchObject({ messaging: true })
    expect(await setup({ guard: null }).surface.show(null, rina.caller)).toMatchObject({
      messaging: false,
    })
  })

  it('rechecks the exact live process against the qualified launch before every prompt', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    expect(await s.surface.send('Who owns Kestrel?', 1, rina.caller)).toBe('ok')
    await started(s)
    s.finish()
    s.processes.at(-1)!.model = { provider: 'unlisted', id: 'other', api: 'other' }
    expect(await s.surface.send('And Northwind?', 2, rina.caller)).toBe('unavailable')
    expect(s.prompts()).toHaveLength(1)
  })
})

describe('the interactive profile', () => {
  it('refuses an interactive turn unless the live process proves the guard loaded', async () => {
    const rina = person('Rina Okafor')
    for (const s of [setup({ guard: null }), setup({ loadsGuard: false })]) {
      expect(await s.surface.send('Who owns Harbor?', 1, rina.caller)).toBe('unavailable')
      expect(await s.surface.tell('Tom Lee leads Ledger', rina.caller)).toBe('unavailable')
      expect(s.prompts()).toEqual([])
    }
  })

  it('refuses command-form input before it reaches pi', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    for (const message of ['/fake-ask', '  /skill:host-only', '!ls ~', ' !!cat /etc/hosts'])
      expect(await s.surface.send(message, 1, rina.caller)).toBe('unavailable')
    expect(s.prompts()).toEqual([])
    expect(await s.surface.send('Who owns Kestrel?', 1, rina.caller)).toBe('ok')
    expect(s.prompts().map(({ command }) => command)).toMatchObject([
      { message: 'Who owns Kestrel?' },
    ])
  })

  it('runs interactive turns guarded and Defrag broad, one process at a time on one transcript', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    expect(await s.surface.send('Who owns Northwind?', 1, rina.caller)).toBe('ok')
    // Defrag waits for the controller's turn, then restarts the lane in its own profile.
    const opening = s.conversation.lane.open({ name: 'Brain' })
    await started(s)
    s.finish()
    await opening
    expect(s.processes.map((p) => [p.profile, p.alive])).toEqual([
      ['interactive', false],
      ['defrag', true],
    ])
    expect(await s.surface.send('And Harbor?', 2, rina.caller)).toBe('ok')
    expect(s.processes.map((p) => [p.profile, p.alive])).toEqual([
      ['interactive', false],
      ['defrag', false],
      ['interactive', true],
    ])
  })

  it('answers busy rather than restarting a process whose turn runs', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    const info = await s.conversation.lane.open({ name: 'Brain' })
    expect(
      await s.conversation.lane.command(info.sessionId, { type: 'prompt', message: 'Defrag.' }),
    ).toMatchObject({ success: true })
    await started(s)
    expect(await s.surface.send('Who owns Ledger?', 1, rina.caller)).toBe('busy')
    expect(s.processes).toHaveLength(1)
  })
})

describe('turn identity', () => {
  it('binds the curator gate to the controller turn that started it', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    expect(await s.surface.send('Merge Rina’s duplicates', 1, rina.caller)).toBe('ok')
    await started(s)
    const gate = s.conversation.turnGate()!
    expect(gate.kind).toBe('controller')
    expect(gate.admit()).toBe(true)
    rina.authority.allowed = false
    expect(gate.admit()).toBe(false)
    rina.authority.allowed = true
    s.finish()
    expect(gate.admit()).toBe(false)
    expect(s.conversation.turnGate()).toBeNull()
  })

  it('gives a Defrag turn its own identity that no controller gate carries over into', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    expect(await s.surface.send('Who owns Harbor?', 1, rina.caller)).toBe('ok')
    await started(s)
    const controllerGate = s.conversation.turnGate()!
    s.finish()
    const info = await s.conversation.lane.open({ name: 'Brain' })
    expect(
      await s.conversation.lane.command(info.sessionId, { type: 'prompt', message: 'Defrag.' }),
    ).toMatchObject({ success: true })
    await started(s)
    expect(s.conversation.turnGate()!.kind).toBe('defrag')
    expect(controllerGate.admit()).toBe(false)
  })

  it('does not let Defrag claim a turn a controller already started', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    expect(await s.surface.send('Who owns Harbor?', 1, rina.caller)).toBe('ok')
    const live = s.processes.at(-1)!.id
    expect(
      await s.conversation.lane.command(live, { type: 'prompt', message: 'Defrag.' }),
    ).toMatchObject({ success: false })
    await started(s)
    expect(s.conversation.turnGate()!.kind).toBe('controller')
    expect(s.prompts()).toHaveLength(1)
  })

  it('stops a controller turn as soon as its authority is revoked', async () => {
    const s = setup()
    const rina = person('Rina Okafor')
    expect(await s.surface.send('stream Kestrel', 1, rina.caller)).toBe('ok')
    await started(s)
    rina.authority.allowed = false
    s.emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'brain_search', args: {} })
    await vi.waitFor(() => expect(s.aborts()).toHaveLength(1))
  })

  it('refuses a message from the Host’s own Tell entry, which carries no authority', async () => {
    const s = setup()
    await expect(s.conversation.lane.tell('Kestrel ships Friday')).rejects.toThrow()
    expect(s.prompts()).toEqual([])
  })
})

import { describe, expect, it, vi } from 'vitest'
import { BRAIN_ACCESS, type BrainAccess } from '@phosphor/shared/brain-access'
import { BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import type { HostCapability } from '@phosphor/shared/remote-host'
import { createBrainAdapter, type BrainSurfaceHandlers } from './brain-adapter'
import { bindBrainLink } from './__fixtures__/brain-link'

const page = {
  entries: [],
  next: null,
  dialogs: [],
  fence: 1,
  controller: null,
  running: false,
  turn: null,
  messaging: false,
}
const CONTROL: readonly HostCapability[] = ['sessions.control']
const ALL = BRAIN_ACCESS

function adapter() {
  const handled = vi.fn((_method: string) => undefined)
  const answer = (method: string, data: unknown) => () => {
    handled(method)
    return { status: 'ok' as const, data }
  }
  const handlers = {
    'brain:laneShow': answer('brain:laneShow', page),
    'brain:laneWatch': answer('brain:laneWatch', page),
    'brain:laneSend': answer('brain:laneSend', null),
    'brain:laneTake': answer('brain:laneTake', null),
    'brain:laneAnswer': answer('brain:laneAnswer', null),
    'brain:laneStop': answer('brain:laneStop', null),
    'brain:tell': answer('brain:tell', null),
  } as unknown as BrainSurfaceHandlers
  return { link: createBrainAdapter(handlers), handled }
}

const conversation = [
  [{ method: 'brain:laneShow', args: [] }, false],
  [{ method: 'brain:laneWatch', args: [] }, false],
  [{ method: 'brain:laneSend', args: ['Who owns Harbor?', 1] }, true],
  [{ method: 'brain:laneTake', args: [1] }, true],
  [
    {
      method: 'brain:laneAnswer',
      args: [{ type: 'extension_ui_response', id: 'q1', confirmed: true }, 1],
    },
    true,
  ],
  [{ method: 'brain:tell', args: ['Tom Lee leads Ledger'] }, true],
] as const

describe('Brain Agent conversation rights', () => {
  it.each(conversation)(
    '%o needs read, control, evidence and configure',
    async (request, write) => {
      const { link, handled } = adapter()
      for (const missing of ALL) {
        const rights = ALL.filter((right) => right !== missing)
        const surface = bindBrainLink('grant-user', link, rights, undefined, CONTROL)
        expect(await surface.run(BRAIN_SURFACE, request, write)).toMatchObject({
          status: 'denied',
          code: 'forbidden',
        })
      }
      expect(handled).not.toHaveBeenCalled()
      const owner = bindBrainLink('owner', link, ALL)
      expect(await owner.run(BRAIN_SURFACE, request, write)).toMatchObject({ status: 'ok' })
      expect(handled).toHaveBeenCalledWith(request.method)
    },
  )

  it.each(conversation)('%o needs sessions.control from a grant user', async (request, write) => {
    const { link, handled } = adapter()
    const without = bindBrainLink('grant-user', link, ALL, undefined, [])
    expect(await without.run(BRAIN_SURFACE, request, write)).toMatchObject({
      status: 'denied',
      code: 'forbidden',
    })
    expect(handled).not.toHaveBeenCalled()
    const granted = bindBrainLink('grant-user', link, ALL, undefined, CONTROL)
    expect(await granted.run(BRAIN_SURFACE, request, write)).toMatchObject({ status: 'ok' })
  })

  it('lets Stop run on control alone and returns no conversation data', async () => {
    const { link, handled } = adapter()
    const stop = { method: 'brain:laneStop', args: [1, 'turn-harbor'] }
    const onlyControl: readonly BrainAccess[] = ['control']
    const grant = bindBrainLink('grant-user', link, onlyControl, undefined, CONTROL)
    expect(await grant.run(BRAIN_SURFACE, stop, true)).toMatchObject({ status: 'ok', data: null })
    expect(handled).toHaveBeenCalledWith('brain:laneStop')
    const noSessions = bindBrainLink('grant-user', link, onlyControl, undefined, [])
    expect(await noSessions.run(BRAIN_SURFACE, stop, true)).toMatchObject({
      status: 'denied',
      code: 'forbidden',
    })
    // Stop alone never reads the conversation.
    expect(await grant.run(BRAIN_SURFACE, { method: 'brain:laneShow', args: [] })).toMatchObject({
      status: 'denied',
      code: 'forbidden',
    })
  })

  it('revokes an in-flight conversation call when the grant loses sessions.control', async () => {
    let release: (() => void) | undefined
    let admitted: boolean | undefined
    const handlers = {
      'brain:laneSend': (_request: unknown, authority: { admit(): boolean }) =>
        new Promise((resolve) => {
          release = () => {
            admitted = authority.admit()
            resolve({ status: 'ok', data: null })
          }
        }),
    } as unknown as BrainSurfaceHandlers
    const surface = bindBrainLink(
      'grant-user',
      createBrainAdapter(handlers),
      ALL,
      undefined,
      CONTROL,
    )
    const sent = surface.run(
      BRAIN_SURFACE,
      { method: 'brain:laneSend', args: ['Kestrel', 1] },
      true,
    )
    await vi.waitFor(() => expect(release).toBeDefined())
    surface.renew(ALL, [])
    release!()
    expect(admitted).toBe(false)
    expect(await sent).toMatchObject({ status: 'denied', code: 'forbidden' })
  })
})

import { expect, it, vi } from 'vitest'
import directives from './directives'
import { directiveDelivery } from '@phosphor/shared/agent-directives'

const b64 = (s: string) => Buffer.from(s).toString('base64')
const add = (s: string) => `<addendum>\n${s}\n</addendum>`
const sys = (sections: Record<string, string | null>) => ({ role: 'system', sections })
function wire(base?: string, env: NodeJS.ProcessEnv = directiveDelivery(base).env) {
  let send!: (event: unknown, ctx: unknown) => unknown
  let command!: (arg: string) => Promise<void>
  const appendEntry = vi.fn()
  const view = directives(
    {
      on: (_key, h) => {
        send = h
      },
      registerCommand: (name, spec) => {
        expect(name).toBe('phosphor-directives')
        command = spec.handler
      },
      appendEntry,
    },
    env,
    base ? ['pi', '--append-system-prompt', base] : ['pi'],
  )
  return {
    command,
    appendEntry,
    view,
    env,
    request: (...messages: unknown[]) => send({ messages }, {}),
  }
}

it.each([true, false])(
  'replaces only the request-local base, including pre-update argv (env=%s)',
  async (newLane) => {
    const lane = wire('old', newLane ? directiveDelivery('old').env : {})
    const start = sys({ preamble: 'pi', addendum: add('old') })
    const patch = sys({ addendum: add('old'), skills: 's' })
    expect(lane.request(start, patch)).toBeUndefined()
    await lane.command(b64('new 🍎'))
    expect(lane.request(start, patch)).toEqual({
      messages: [sys({ preamble: 'pi', addendum: add('new 🍎') }), sys({ skills: 's' })],
    })
    expect(start.sections.addendum).toBe(add('old'))
    expect(patch.sections.addendum).toBe(add('old'))
    expect(lane.view.prompt(add('old'))).toBe(add('new 🍎'))
    expect(lane.appendEntry).toHaveBeenCalledWith('phosphor-directives', { text: 'new 🍎' })
    const reloaded = wire('old', lane.env)
    expect(reloaded.request(start)).toEqual({
      messages: [sys({ preamble: 'pi', addendum: add('new 🍎') })],
    })
    await reloaded.command('-')
    expect(reloaded.request(start, patch)).toEqual({
      messages: [sys({ preamble: 'pi' }), sys({ skills: 's' })],
    })
  },
)

it('keeps APPEND_SYSTEM.md and ignores inherited env in a lane without a base', async () => {
  const start = sys({ addendum: add('user file') })
  const lane = wire(undefined, {
    PHOSPHOR_DIRECTIVES_BASE: b64('user file'),
    PHOSPHOR_DIRECTIVES: `${process.pid + 1}:${b64('parent')}`,
  })
  expect(lane.request(start)).toBeUndefined()
  await lane.command(b64('live'))
  expect(lane.request(start)).toEqual({
    messages: [
      sys({
        ...start.sections,
        phosphor_directives: '<phosphor_directives>\nlive\n</phosphor_directives>',
      }),
    ],
  })
  await lane.command('-')
  expect(lane.request(start)).toEqual({ messages: [start] })
  await expect(lane.command('bad!')).rejects.toThrow('base64')
})

it('matches a resumed base established in a later system patch without adding another section', async () => {
  const lane = wire('fresh')
  const start = sys({ addendum: add('historic') })
  await lane.command(b64('replacement'))
  expect(lane.request(start, sys({ addendum: add('fresh') }))).toEqual({
    messages: [start, sys({ addendum: add('replacement') })],
  })
})

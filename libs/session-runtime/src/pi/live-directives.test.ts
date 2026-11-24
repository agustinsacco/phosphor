import { expect, it, vi } from 'vitest'
import { createLiveDirectives } from './live-directives'

it('pushes only changed text in scope, after one supported-command check per lane', async () => {
  let text: string | undefined = 'initial'
  const live = createLiveDirectives('/repo', () => text, text)
  const request = vi.fn(async ({ type }) => ({
    success: true,
    data:
      type === 'get_commands'
        ? { commands: [{ name: 'phosphor-directives', source: 'extension' }] }
        : undefined,
  }))
  await live(request as never)
  text = 'changed'
  await live(request as never, '/other')
  expect(request).not.toHaveBeenCalled()
  await live(request as never, '/repo')
  text = undefined
  await live(request as never)
  expect(request.mock.calls.map(([v]) => v)).toEqual([
    { type: 'get_commands' },
    {
      type: 'prompt',
      message: `/phosphor-directives ${Buffer.from('changed').toString('base64')}`,
    },
    { type: 'prompt', message: '/phosphor-directives -' },
  ])
})

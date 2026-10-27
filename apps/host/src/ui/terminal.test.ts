import { PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { richTerminal } from './terminal'

const tty = (colors = true) =>
  Object.assign(new PassThrough(), { isTTY: true, hasColors: () => colors })

it('is a screen only when both ends are a terminal', () => {
  expect(richTerminal({}, tty(), tty())).toMatchObject({ color: true, animate: true })
  expect(richTerminal({}, new PassThrough(), tty())).toBeUndefined()
  expect(richTerminal({}, tty(), new PassThrough())).toBeUndefined()
})

it.each([
  [{ TERM: 'dumb' }],
  [{ CI: 'true' }],
  [{ CI: '1' }],
  [{ GITHUB_ACTIONS: 'true' }],
  [{ PHOSPHOR_PLAIN: '1' }],
])('stays plain for %j', (env) => {
  expect(richTerminal(env, tty(), tty())).toBeUndefined()
})

it('keeps the layout without colour when the terminal has none', () => {
  expect(richTerminal({ CI: 'false' }, tty(), tty(false))).toMatchObject({ color: false })
})

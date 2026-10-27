import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SetupCancelled } from '../commands/setup-terminal'
import { fakeTerminal } from './__fixtures__/fake-terminal'
import { createScreen, screenFor } from './screen'
import { startSpinner } from './spinner'
import { painter } from './theme'

// A screen is only drawn outside CI (ui/terminal.ts), and Clack's task log
// stops redrawing when CI=true, so these run as a person's terminal does.
beforeEach(() => vi.stubEnv('CI', undefined))
afterEach(() => vi.unstubAllEnvs())

describe('screen', () => {
  it('draws a command as one rail: its title, blocks, rows and closing line', () => {
    const t = fakeTerminal()
    const screen = createScreen(t.terminal)
    screen.open('phosphor doctor', 'bee2')
    screen.list('This machine', [
      { tone: 'ok', name: 'pi', text: 'ready' },
      { tone: 'warn', name: 'git', text: 'old' },
    ])
    screen.say('Next: phosphor setup', 'info')
    screen.close('Ready.')
    expect(t.text()).toBe(
      [
        '┌  phosphor doctor · bee2',
        '│',
        '◇  This machine',
        '│  ✓ pi   ready',
        '│  ▲ git  old',
        '│',
        '●  Next: phosphor setup',
        '│',
        '└  Ready.',
        '',
        '',
      ].join('\n'),
    )
  })

  it('wraps a long line onto the rail instead of past the edge', () => {
    const t = fakeTerminal(30)
    createScreen(t.terminal).say('a sentence long enough to need two lines here')
    expect(t.text()).toBe(
      ['│', '◇  a sentence long enough to', '│  need two lines here', ''].join('\n'),
    )
  })

  it('ends a spinner as a finished line, or without a trace', async () => {
    const t = fakeTerminal()
    const screen = createScreen(t.terminal)
    screen.busy('Checking pi').done('pi ready', 'ok')
    expect(t.text()).toBe('│\n◆  pi ready\n')
    const cleared = fakeTerminal()
    await createScreen(cleared.terminal).during('Checking', async () => {})
    expect(cleared.text()).toBe('')
  })

  it('prints above a running spinner, which carries on below', () => {
    const t = fakeTerminal()
    const screen = createScreen(t.terminal)
    const busy = screen.busy('Restarting')
    screen.say('Service restarted.', 'info')
    expect(t.text()).toBe('│\n●  Service restarted.\n│\n◒  Restarting')
    busy.done('Healthy', 'ok')
    expect(t.text()).toBe('│\n●  Service restarted.\n│\n◆  Healthy\n')
  })

  it('clears its spinner when the work throws', async () => {
    const t = fakeTerminal()
    const screen = createScreen(t.terminal)
    await expect(
      screen.during('Checking', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom')
    screen.close('Done.')
    expect(t.text()).toBe('│\n└  Done.\n\n')
  })

  it.each([
    ['y', true],
    ['n', false],
    ['\r', true],
  ])('answers a question typed %j as %s', async (key, answer) => {
    const t = fakeTerminal()
    t.type(key)
    expect(await createScreen(t.terminal).ask('Go ahead?')).toBe(answer)
  })

  it.each(['\x1b', '\x03'])('throws SetupCancelled for %j', async (key) => {
    const t = fakeTerminal()
    t.type(key)
    await expect(createScreen(t.terminal).ask('Go ahead?')).rejects.toBeInstanceOf(SetupCancelled)
  })

  it('throws SetupCancelled when the command is aborted mid-question', async () => {
    const t = fakeTerminal()
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 20)
    await expect(
      createScreen(t.terminal).ask('Go ahead?', controller.signal),
    ).rejects.toBeInstanceOf(SetupCancelled)
  })

  it("collapses a task's log on success and keeps it on failure", () => {
    const t = fakeTerminal()
    const screen = createScreen(t.terminal)
    const ok = screen.task('npm install')
    ok.line('added 1 package\nadded 2 packages\n')
    ok.done('done', true)
    const failed = screen.task('pi install')
    failed.line('npm ERR! code E404')
    failed.done('failed (exit 1)', false)
    const text = t.text()
    expect(text).toContain('◆  npm install · done')
    expect(text).not.toContain('added 2 packages')
    expect(text).toContain('■  pi install · failed (exit 1)')
    expect(text).toContain('npm ERR! code E404')
  })

  it('is only for a terminal, and never with --json', () => {
    const { terminal } = fakeTerminal()
    expect(screenFor(undefined)).toBeNull()
    expect(screenFor(terminal, true)).toBeNull()
    expect(screenFor(terminal)).not.toBeNull()
  })
})

describe('spinner', () => {
  it('shows how long it has run once it takes a while, and shortens a long text', () => {
    const t = fakeTerminal(30)
    let now = 0
    const busy = startSpinner(
      t.terminal,
      painter(false),
      'Downloading the release...',
      () => {},
      () => now,
    )
    expect(t.text()).toBe('│\n◒  Downloading the release')
    now = 12_000
    busy.update('Waiting for the Host to come up healthy')
    expect(t.text()).toBe('│\n◒  Waiting for the Hos… 12s')
    busy.clear()
  })

  it('swallows typing and turns Ctrl-C into the Host interrupt, restoring the terminal', () => {
    const t = fakeTerminal()
    const setRawMode = vi.fn()
    Object.assign(t.input, { isTTY: true, setRawMode })
    startSpinner(t.terminal, painter(false), 'Working')
    expect(setRawMode).toHaveBeenLastCalledWith(true)
    t.input.write('q')
    expect(t.interrupt).not.toHaveBeenCalled()
    t.input.write('\x03')
    expect(t.interrupt).toHaveBeenCalledOnce()
    expect(setRawMode).toHaveBeenLastCalledWith(false)
    expect(t.text()).toBe('│\n■  Cancelled\n')
    expect(t.raw().endsWith('\x1b[?25h')).toBe(true)
  })
})

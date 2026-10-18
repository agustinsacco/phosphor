import { afterEach, describe, expect, it, vi } from 'vitest'

const names = [
  'chat',
  'changes',
  'files',
  'files-left',
  'files-full',
  'terminal',
  'home',
  'artifacts',
  'subagents',
  'settings',
  'light',
]

type Event = [string, ...unknown[]]
type Options = {
  only?: string
  width?: string
  sipsFails?: boolean
  fail?: boolean
  stuck?: boolean
}

function fakePage(events: Event[], fail = false) {
  const locator = (route: string): object =>
    new Proxy(
      {},
      {
        get: (_, key: string | symbol) => {
          if (key === Symbol.toPrimitive) return () => route
          if (typeof key !== 'string' || key === 'then') return undefined
          return (...args: unknown[]) => {
            events.push([key, route, ...args])
            if (key === 'isVisible') return true
            if (key === 'getAttribute') return 'false'
            if (key === 'evaluate') return undefined
            if (key === 'click' && fail) throw new Error('scenario failed')
            return /^(or|first|nth|filter|getBy)/.test(key)
              ? locator(`${route}/${key}:${args.map(String).join('|')}`)
              : undefined
          }
        },
      },
    )
  return new Proxy(
    { keyboard: { press: (key: string) => events.push(['press', key]) } },
    {
      get: (target, key: string) => {
        if (key === 'then') return undefined
        if (key === 'keyboard') return target.keyboard
        return (...args: unknown[]) => {
          events.push([key, ...args])
          return /^(getBy)/.test(key) ? locator(`${key}:${args.map(String).join('|')}`) : undefined
        }
      },
    },
  )
}

function fakeApp(events: Event[], options: Options) {
  const win = {
    isDestroyed: () => false,
    isVisible: () => false,
    show: () => events.push(['show']),
    moveTop: () => events.push(['moveTop']),
    focus: () => events.push(['focus']),
    getBounds: () => ({ height: 900, width: 1400 }),
    setBounds: (bounds: object) => events.push(['setBounds', bounds]),
    capturePage: async () => {
      events.push(['capturePage'])
      return { toDataURL: () => 'data:image/png;base64,aGVsbG8=' }
    },
  }
  return {
    firstWindow: async () => fakePage(events, options.fail),
    evaluate: (fn: (electron: object, value: unknown) => unknown, value: unknown) =>
      fn({ BrowserWindow: { getAllWindows: () => [win] } }, value),
    close: () => {
      events.push(['close'])
      return options.stuck ? new Promise(() => {}) : Promise.resolve()
    },
    process: () => ({ kill: (signal: string) => events.push(['kill', signal]) }),
  }
}

function mockDependencies(events: Event[], options: Options) {
  vi.doMock('node:fs/promises', () => ({
    mkdir: async (...args: unknown[]) => {
      events.push(['mkdir', ...args])
    },
    mkdtemp: async () => '/scratch/project',
    writeFile: async (...args: unknown[]) => {
      events.push(['writeFile', ...args])
    },
    rm: async (...args: unknown[]) => {
      events.push(['rm', ...args])
    },
  }))
  vi.doMock('node:fs', () => ({
    mkdtempSync: () => '/scratch/agent',
    statSync: () => ({ size: 2048 }),
  }))
  vi.doMock('node:child_process', () => ({
    execFileSync: (...args: unknown[]) => {
      events.push(['exec', ...args])
      if (args[0] === 'sips' && options.sipsFails) throw new Error('no sips')
    },
  }))
  vi.doMock('./desktop-electron-launch.mjs', () => ({
    desktopElectronLaunchOptions: (args: string[]) => ({ args, executablePath: '/electron' }),
  }))
  vi.doMock('playwright', () => ({
    _electron: {
      launch: async (args: unknown) => {
        events.push(['launch', args])
        return fakeApp(events, options)
      },
    },
  }))
}

async function runCli(options: Options = {}) {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubEnv('ONLY', options.only ?? '')
  vi.stubEnv('MAX_WIDTH', options.width ?? '1440')
  vi.stubEnv('OUT_DIR', '/shots')
  for (const key of ['ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_CLI_ARGS']) {
    vi.stubEnv(key, 'must-not-leak')
  }
  const events: Event[] = []
  mockDependencies(events, options)
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    events.push(['log', ...args])
  })
  vi.spyOn(console, 'error').mockImplementation((error: Error) => {
    events.push(['error', error.message])
  })
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  await import('./capture-readme-shots.mjs')
  await vi.waitFor(() => expect(events).toContainEqual(['close']), { interval: 0 })
  if (options.stuck) {
    await vi.advanceTimersByTimeAsync(14_999)
    expect(events.some(([kind]) => kind === 'kill' || kind === 'rm')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
  }
  await vi.waitFor(() => expect(events.filter(([kind]) => kind === 'rm')).toHaveLength(2))
  return events
}

const captures = (events: Event[]) =>
  events
    .filter(([kind, path]) => kind === 'writeFile' && String(path).endsWith('.png'))
    .map(([, path]) => String(path).replace('/shots/', '').replace('.png', ''))

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('capture-readme-shots CLI characterization', () => {
  it('isolates launch env, seeds git and captures the ordered scenarios', async () => {
    const events = await runCli()
    const launch = events.find(([kind]) => kind === 'launch')?.[1] as {
      args: string[]
      executablePath: string
      env: Record<string, string>
    }
    expect(launch.args).toEqual([expect.stringContaining('apps/desktop'), '--disable-gpu'])
    expect(launch.executablePath).toBe('/electron')
    expect(launch.env).toMatchObject({
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: expect.stringContaining('/pi-stub.cjs'),
      PHOSPHOR_E2E_WORKSPACE: '/scratch/project/welcome-app',
      PHOSPHOR_TEST_USER_DATA: '1',
      PI_CODING_AGENT_DIR: '/scratch/agent',
      PHOSPHOR_E2E_SHOW: '1',
    })
    for (const key of ['ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_CLI_ARGS']) {
      expect(launch.env).not.toHaveProperty(key)
    }
    expect(
      events.filter(([kind, command]) => kind === 'exec' && command === 'git').map((e) => e[2]),
    ).toEqual([
      ['init', '-b', 'main'],
      ['config', 'user.email', 'shots@phosphor.dev'],
      ['config', 'user.name', 'Phosphor shots'],
      ['add', '-A'],
      ['commit', '-m', 'initial'],
    ])
    expect(captures(events)).toEqual(names)
    expect(events.filter(([kind]) => kind === 'fill').map((e) => e[2])).toEqual([
      'Update hello.ts',
      'Update hello world greeting',
      'write a longartifact please',
      'Draft the long-form report',
      'Fix the token refresh bug, split the work in parallel',
      'Fix the token refresh bug',
    ])
    expect(events.filter(([kind]) => kind === 'waitForTimeout').map((e) => e[1])).toEqual([
      3500, 200, 400, 3500, 200, 400, 3500, 3000, 200, 400, 3500, 200, 400, 2500, 3000, 200, 400,
      2500, 3500, 200, 400, 2200, 200, 400, 2500, 200, 400, 3000, 200, 400, 2400, 200, 400, 3500,
      200, 400,
    ])
    expect(events.slice(-3)).toEqual([
      ['close'],
      ['rm', '/scratch/project', { recursive: true, force: true }],
      ['rm', '/scratch/agent', { recursive: true, force: true }],
    ])
  })

  it('filters capture only, preserving scenario actions and image/downscale order', async () => {
    const events = await runCli({ only: ' settings, chat ,unknown ' })
    expect(captures(events)).toEqual(['chat', 'settings'])
    const index = events.findIndex(([kind]) => kind === 'capturePage')
    expect(events.slice(index - 10, index + 4)).toEqual([
      ['show'],
      ['moveTop'],
      ['focus'],
      ['setBounds', { height: 899, width: 1400 }],
      ['waitForTimeout', 200],
      ['show'],
      ['moveTop'],
      ['focus'],
      ['setBounds', { height: 901, width: 1400 }],
      ['waitForTimeout', 400],
      ['capturePage'],
      ['writeFile', '/shots/chat.png', Buffer.from('hello')],
      [
        'exec',
        'sips',
        ['-Z', '1440', '/shots/chat.png', '--out', '/shots/chat.png'],
        { stdio: 'ignore' },
      ],
      ['log', '  ✓ chat.png (2 KB)'],
    ])
    expect(
      events.some(([kind, , text]) => kind === 'fill' && text === 'Draft the long-form report'),
    ).toBe(true)
    expect(events).toContainEqual(['log', 'captured: chat, settings'])
  })

  it('keeps the device image when sips fails', async () => {
    const events = await runCli({ only: 'chat', sipsFails: true })
    expect(captures(events)).toEqual(['chat'])
    expect(events).toContainEqual(['log', 'captured: chat'])
  })

  it('skips sips for MAX_WIDTH=0', async () => {
    const events = await runCli({ only: 'chat', width: '0' })
    expect(captures(events)).toEqual(['chat'])
    expect(events.some(([kind, cmd]) => kind === 'exec' && cmd === 'sips')).toBe(false)
  })

  it('reports no matching shots without skipping scenario actions', async () => {
    const events = await runCli({ only: 'unknown' })
    expect(captures(events)).toEqual([])
    expect(events).toContainEqual(['log', 'captured: none'])
    expect(events).toContainEqual(['press', 'Escape'])
  })

  it('cleans scratch paths before surfacing a scenario error', async () => {
    const events = await runCli({ fail: true })
    await vi.waitFor(() => expect(events).toContainEqual(['error', 'scenario failed']))
    expect(
      events.filter(([kind]) => ['close', 'rm', 'error'].includes(kind)).map((e) => e[0]),
    ).toEqual(['close', 'rm', 'rm', 'error'])
    expect(process.exit).toHaveBeenCalledWith(1)
  })

  it('kills a stuck close at exactly 15 seconds before cleanup', async () => {
    const events = await runCli({ only: 'unknown', stuck: true })
    expect(events.slice(-4)).toEqual([
      ['close'],
      ['kill', 'SIGKILL'],
      ['rm', '/scratch/project', { recursive: true, force: true }],
      ['rm', '/scratch/agent', { recursive: true, force: true }],
    ])
    expect(vi.getMockedSystemTime()).not.toBeNull()
  })

  it('also bounds close and cleans up when a scenario has failed', async () => {
    const events = await runCli({ fail: true, stuck: true })
    await vi.waitFor(() => expect(events).toContainEqual(['error', 'scenario failed']))
    expect(
      events.filter(([kind]) => ['close', 'kill', 'rm', 'error'].includes(kind)).map((e) => e[0]),
    ).toEqual(['close', 'kill', 'rm', 'rm', 'error'])
  })
})

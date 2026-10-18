// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const io = vi.hoisted(() => ({
  events: [] as string[],
  launch: vi.fn(),
  close: vi.fn(),
  write: vi.fn(),
  resize: vi.fn(),
}))
vi.mock('playwright', () => ({ _electron: { launch: io.launch } }))
vi.mock('./desktop-electron-launch.mjs', () => ({
  desktopElectronLaunchOptions: (args: string[]) => ({ executablePath: '/fake/electron', args }),
}))
vi.mock('node:fs/promises', () => {
  const methods = { mkdir: vi.fn(), writeFile: io.write }
  return { ...methods, default: methods }
})
vi.mock('node:fs', () => {
  const methods = { statSync: () => ({ size: 2048 }) }
  return { ...methods, default: methods }
})
vi.mock('node:child_process', () => ({
  execFileSync: io.resize,
  default: { execFileSync: io.resize },
}))

type Callback = (arg: unknown) => unknown
class Locator {
  constructor(readonly name: string) {}
  first() {
    return this
  }
  last() {
    return this
  }
  nth(index: number) {
    return new Locator(`${this.name}[${index}]`)
  }
  or(_other: Locator) {
    return this
  }
  filter(options: { hasText: RegExp }) {
    io.events.push(`filter:${options.hasText}`)
    return this
  }
  getByRole(_role: string, options: { name: string | RegExp }) {
    return new Locator(`${this.name}/${options.name}`)
  }
  async click() {
    io.events.push(`click:${this.name}`)
  }
  async fill(value: string) {
    io.events.push(`fill:${this.name}:${value}`)
  }
  async check() {
    io.events.push(`check:${this.name}`)
  }
  async uncheck() {
    io.events.push(`uncheck:${this.name}`)
  }
  async waitFor(options: object) {
    io.events.push(`wait:${this.name}:${JSON.stringify(options)}`)
  }
  async isVisible() {
    return true
  }
  async getAttribute(_name: string) {
    return 'false'
  }
  async evaluate(_callback: Callback) {
    io.events.push(`scroll:${this.name}`)
  }
}

function fakePage() {
  return {
    waitForLoadState: vi.fn(),
    emulateMedia: vi.fn(),
    waitForTimeout: async (ms: number) => {
      io.events.push(`settle:${ms}`)
    },
    getByRole: (_role: string, options: { name: string | RegExp }) =>
      new Locator(String(options.name)),
    getByPlaceholder: (name: string | RegExp) => new Locator(String(name)),
    getByTestId: (name: string) => new Locator(name),
    getByTitle: (name: string | RegExp) => new Locator(String(name)),
    getByLabel: (name: string, options: object) => {
      io.events.push(`label:${name}:${JSON.stringify(options)}`)
      return new Locator(name)
    },
    getByText: (name: string) => new Locator(name),
    locator: (name: string) => new Locator(name),
    keyboard: {
      press: async (key: string) => {
        io.events.push(`key:${key}`)
      },
      type: async (text: string) => {
        io.events.push(`type:${text}`)
      },
    },
    evaluate: async (callback: (pairs: string[][]) => unknown, pairs: string[][]) => {
      io.events.push('redact')
      callback(pairs)
    },
  }
}

function fakeApp() {
  const dialog = { showMessageBox: async () => ({ response: 0, checkboxChecked: true }) }
  const win = {
    isDestroyed: () => false,
    isVisible: () => false,
    show: () => {
      io.events.push('show')
    },
    moveTop: vi.fn(),
    focus: vi.fn(),
    getBounds: () => ({ width: 1440, height: 900 }),
    setBounds: (bounds: { height: number }) => {
      io.events.push(`height:${bounds.height}`)
    },
    capturePage: async () => {
      io.events.push(`capture:${document.body.textContent}`)
      expect(Reflect.get(globalThis, '__shotRedactor')).toBeInstanceOf(MutationObserver)
      return { toDataURL: () => 'data:image/png;base64,aW1hZ2U=' }
    },
  }
  return {
    firstWindow: async () => fakePage(),
    evaluate: async (callback: (ports: object, arg?: unknown) => unknown, arg?: unknown) =>
      callback({ BrowserWindow: { getAllWindows: () => [win] }, dialog }, arg),
    close: async () => {
      io.close(await dialog.showMessageBox())
    },
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  io.events.length = 0
  document.body.textContent = 'person@private.test internal-mcp'
  vi.stubEnv('HOME', '/fake/home')
  vi.stubEnv('WORKSPACE', '/fake/real-workspace')
  vi.stubEnv('OUT_DIR', '/fake/shots')
  vi.stubEnv('PHOSPHOR_PI_STUB', '/never/run-stub')
  vi.stubEnv('PI_CODING_AGENT_DIR', '/never/agent')
  vi.stubEnv('ELECTRON_RENDERER_URL', 'http://never.test')
  vi.stubEnv('NODE_ENV_ELECTRON_VITE', 'development')
  vi.stubEnv('ELECTRON_CLI_ARGS', 'unsafe')
  for (const key of [
    'ONLY',
    'REDACT',
    'MAX_WIDTH',
    'TASK_EDIT',
    'TASK_ARTIFACT',
    'PROVIDER_EDIT',
    'MODEL_EDIT',
    'PROVIDER_ARTIFACT',
    'MODEL_ARTIFACT',
  ])
    vi.stubEnv(key, '')
  // Unset defaults rather than overriding them with empty strings.
  for (const key of [
    'MAX_WIDTH',
    'TASK_EDIT',
    'TASK_ARTIFACT',
    'PROVIDER_EDIT',
    'MODEL_EDIT',
    'PROVIDER_ARTIFACT',
    'MODEL_ARTIFACT',
  ])
    delete process.env[key]
  io.launch.mockResolvedValue(fakeApp())
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
})
afterEach(() => {
  Reflect.get(globalThis, '__shotRedactor')?.disconnect()
  Reflect.deleteProperty(globalThis, '__shotRedactor')
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function runCli() {
  await import('./capture-live-shots.mjs')
  await vi.waitFor(() => expect(io.close).toHaveBeenCalled())
}

it('launches real mode without stub/agent overrides and retains the real workspace', async () => {
  vi.stubEnv('ONLY', 'home')
  await runCli()
  const options = io.launch.mock.calls[0]![0]
  expect(options.args).toEqual([expect.stringMatching(/apps\/desktop$/), '--disable-gpu'])
  expect(options.env).toMatchObject({
    NODE_ENV: 'production',
    PHOSPHOR_E2E_WORKSPACE: '/fake/real-workspace',
    PHOSPHOR_TEST_USER_DATA: '1',
    PHOSPHOR_E2E_SHOW: '1',
  })
  for (const key of [
    'PHOSPHOR_PI_STUB',
    'PI_CODING_AGENT_DIR',
    'ELECTRON_RENDERER_URL',
    'NODE_ENV_ELECTRON_VITE',
    'ELECTRON_CLI_ARGS',
  ])
    expect(options.env).not.toHaveProperty(key)
  const edit = io.events.find((event) =>
    event.startsWith('fill:Describe a task or ask a question:'),
  )
  expect(edit).toContain('do not run git or gh, do not commit, do not push, do not open a PR.')
  expect(io.events).toContain('check:new branch')
  expect(io.events).toContain('uncheck:new branch')
})

it('redacts emails/custom text and installs the observer before each ordered capture, then answers quit', async () => {
  vi.stubEnv('REDACT', 'internal-mcp=knowledge')
  await runCli()
  expect(io.write.mock.calls.map(([path]) => path.split('/').pop())).toEqual([
    'chat.png',
    'changes.png',
    'files.png',
    'files-left.png',
    'files-full.png',
    'terminal.png',
    'artifacts.png',
    'models.png',
    'thinking.png',
    'context.png',
    'commands.png',
    'mentions.png',
    'home.png',
    'settings.png',
    'accounts.png',
    'connectors.png',
    'light.png',
  ])
  const captures = io.events.filter((event) => event.startsWith('capture:'))
  expect(captures).toHaveLength(17)
  expect(new Set(captures)).toEqual(new Set(['capture:you@example.com knowledge']))
  io.events.forEach((event, index) => {
    if (event.startsWith('capture:')) expect(io.events[index - 1]).toBe('redact')
  })
  expect(io.write.mock.calls[0]![1].toString()).toBe('image')
  expect(io.resize.mock.calls[0]).toEqual([
    'sips',
    ['-Z', '1440', '/fake/shots/chat.png', '--out', '/fake/shots/chat.png'],
    { stdio: 'ignore' },
  ])
  expect(io.close).toHaveBeenCalledWith({ response: 1, checkboxChecked: false })
})

it('reports CLI failure with a nonzero exit and still quits after a scenario error', async () => {
  const app = fakeApp()
  app.firstWindow = async () => ({
    ...fakePage(),
    getByRole: () => {
      throw new Error('fake scenario failure')
    },
  })
  io.launch.mockResolvedValue(app)
  await runCli()
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1))
  expect(console.error).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'fake scenario failure' }),
  )
  expect(io.close).toHaveBeenCalledWith({ response: 1, checkboxChecked: false })
})

it('reports launch failure with a nonzero exit without accessing real Electron', async () => {
  io.launch.mockRejectedValue(new Error('fake launch failure'))
  await import('./capture-live-shots.mjs')
  await vi.waitFor(() => expect(process.exit).toHaveBeenCalledWith(1))
  expect(console.error).toHaveBeenCalledWith(
    expect.objectContaining({ message: 'fake launch failure' }),
  )
  expect(io.close).not.toHaveBeenCalled()
})

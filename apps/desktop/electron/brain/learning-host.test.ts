import { afterEach, expect, it, vi } from 'vitest'
import { createDesktopLearningHost } from './learning-host'
import { createLearningHost } from '@phosphor/brain-runtime/learning-host'
import { readLearningSourceBinding } from '@phosphor/brain-runtime/learning-source-binding'
import { registry } from '../registry'
import { sessionPaths } from '../pi/session-path-lock'

vi.mock('@phosphor/brain-runtime/learning-host', () => ({ createLearningHost: vi.fn(() => ({})) }))
vi.mock('@phosphor/brain-runtime/learning-source-binding', () => ({
  readLearningSourceBinding: vi.fn(),
}))
vi.mock('../registry', () => ({ registry: {} }))
vi.mock('../pi/session-runtime', () => ({ desktopSessions: {} }))
vi.mock('../pi/session-path-lock', () => ({ sessionPaths: {} }))
vi.mock('../pi/binary-lookup', () => ({
  resolveBinary: vi.fn(async () => '/synthetic/pi'),
  windowsWhereOutput: vi.fn(),
}))
vi.mock('../pi/shell-env', () => ({ getLoginShellPath: vi.fn(async () => '/synthetic/bin') }))
vi.mock('../pi/stub', () => ({ piStubPath: () => undefined }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
vi.mock('@phosphor/session-runtime/pi/pi-paths', () => ({
  piAgentDir: () => '/synthetic/agent',
  piSessionsRoot: () => '/synthetic/sessions',
}))

const selection = {
  provider: 'openai',
  modelId: 'exact',
  api: 'openai-responses',
  thinkingLevel: 'high' as const,
}
const target = { sessionPath: '/synthetic/source.jsonl', workspacePath: '/synthetic/workspace' }
const source = {
  sessionId: 'source',
  selectedLeafId: 'a',
  sourceDigest: 'digest',
  contentDigest: 'content',
  entries: [],
}
const binding = {
  binding: {
    ...selection,
    endpoint: 'https://api.openai.com/v1',
    authMode: 'oauth' as const,
    accountId: 'opaque-slot',
  },
  authIdentityFence: 'opaque-epoch',
  sessionId: 'source',
  selectedLeafId: 'a',
  settled: true as const,
}
function resolver() {
  createDesktopLearningHost({
    directory: '/synthetic/private',
    extensionPath: '/synthetic/carrier.mjs',
  })
  return vi.mocked(createLearningHost).mock.calls.at(-1)![0].resolve
}
afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})
it('wires the trusted admitted source into the native reader and retains only the managed environment allowlist', async () => {
  vi.stubEnv('OPENAI_API_KEY', 'synthetic-must-not-copy')
  vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'synthetic-must-not-copy')
  vi.mocked(readLearningSourceBinding).mockResolvedValue(binding)
  const signal = new AbortController().signal
  const resolved = await resolver()(selection, target, 'live', signal, source)
  expect(readLearningSourceBinding).toHaveBeenCalledWith(
    { registry, paths: sessionPaths, sessionsRoot: '/synthetic/sessions' },
    target,
    'live',
    source,
    signal,
  )
  expect(resolved.sourceBinding).toBe(binding)
  expect(resolved.env).not.toHaveProperty('OPENAI_API_KEY')
  expect(resolved.env).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN')
  expect(resolved.env).not.toHaveProperty('PI_API_KEY')
  expect(resolved.binaryPath).toBe('/synthetic/pi')
})
it('keeps offline native current-slot preparation unchanged without manufacturing historical source proof', async () => {
  const resolved = await resolver()(
    selection,
    target,
    undefined,
    new AbortController().signal,
    source,
  )
  expect(readLearningSourceBinding).not.toHaveBeenCalled()
  expect(resolved.sourceBinding).toBeUndefined()
  expect(resolved.agentDir).toBe('/synthetic/agent')
})
it.each([undefined, 'live'])(
  'explicitly refuses CLI %s while actual identity hooks are unavailable',
  async (live) => {
    await expect(
      resolver()(
        { ...selection, provider: 'pi-claude-cli' },
        target,
        live,
        new AbortController().signal,
        source,
      ),
    ).rejects.toThrow('CLI source identity hook is unavailable')
    expect(readLearningSourceBinding).not.toHaveBeenCalled()
  },
)
it('never substitutes an offline current slot when live attestation fails', async () => {
  vi.mocked(readLearningSourceBinding).mockRejectedValue(new Error('source binding changed'))
  await expect(
    resolver()(selection, target, 'live', new AbortController().signal, source),
  ).rejects.toThrow('source binding changed')
})

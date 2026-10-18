import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareReadmeShots } from './readme-setup.mjs'

vi.mock('node:fs/promises', () => ({ mkdir: vi.fn(), mkdtemp: vi.fn(), writeFile: vi.fn() }))
vi.mock('node:fs', () => ({ mkdtempSync: vi.fn() }))
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(mkdtemp).mockResolvedValue('/scratch/project')
  vi.mocked(mkdtempSync).mockReturnValue('/scratch/agent')
})
afterEach(() => vi.unstubAllEnvs())

describe('prepareReadmeShots', () => {
  it('seeds a named workspace and the original git subprocess arguments', async () => {
    const result = await prepareReadmeShots({ outDir: '/shots', piStub: '/pi-stub.cjs' })
    expect(result).toMatchObject({
      root: '/scratch/project',
      workspace: '/scratch/project/welcome-app',
      agentDir: '/scratch/agent',
    })
    expect(mkdir).toHaveBeenNthCalledWith(1, '/shots', { recursive: true })
    expect(mkdir).toHaveBeenNthCalledWith(2, result.workspace, { recursive: true })
    expect(mkdtemp).toHaveBeenCalledWith(join(tmpdir(), 'phosphor-shots-'))
    expect(mkdtempSync).toHaveBeenCalledWith(join(tmpdir(), 'phosphor-shots-agent-'))
    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      join(result.workspace, 'hello.ts'),
      'export function hello() {\n  return "old"\n}\n',
    )
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      join(result.workspace, 'README.md'),
      '# welcome-app\n\nA tiny demo project used to show Phosphor in its own README.\n',
    )
    expect(vi.mocked(execFileSync).mock.calls).toEqual([
      ['git', ['init', '-b', 'main'], { cwd: result.workspace, stdio: 'ignore' }],
      [
        'git',
        ['config', 'user.email', 'shots@phosphor.dev'],
        { cwd: result.workspace, stdio: 'ignore' },
      ],
      [
        'git',
        ['config', 'user.name', 'Phosphor shots'],
        { cwd: result.workspace, stdio: 'ignore' },
      ],
      ['git', ['add', '-A'], { cwd: result.workspace, stdio: 'ignore' }],
      ['git', ['commit', '-m', 'initial'], { cwd: result.workspace, stdio: 'ignore' }],
    ])
    expect(vi.mocked(writeFile).mock.invocationCallOrder[1]).toBeLessThan(
      Number(vi.mocked(execFileSync).mock.invocationCallOrder[0]),
    )
    expect(vi.mocked(execFileSync).mock.invocationCallOrder[4]).toBeLessThan(
      Number(vi.mocked(mkdtempSync).mock.invocationCallOrder[0]),
    )
  })

  it('copies inherited env, strips renderer overrides and isolates stub state without mutating process.env', async () => {
    for (const key of ['ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_CLI_ARGS']) {
      vi.stubEnv(key, 'inherited-override')
    }
    vi.stubEnv('NODE_ENV', 'development')
    vi.stubEnv('PI_CODING_AGENT_DIR', '/real/agent')
    vi.stubEnv('PHOSPHOR_E2E_SHOW', '0')
    const { env } = await prepareReadmeShots({ outDir: '/shots', piStub: '/pi-stub.cjs' })
    expect(env).toMatchObject({
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: '/pi-stub.cjs',
      PHOSPHOR_E2E_WORKSPACE: '/scratch/project/welcome-app',
      PHOSPHOR_TEST_USER_DATA: '1',
      PI_CODING_AGENT_DIR: '/scratch/agent',
      PHOSPHOR_E2E_SHOW: '1',
    })
    for (const key of ['ELECTRON_RENDERER_URL', 'NODE_ENV_ELECTRON_VITE', 'ELECTRON_CLI_ARGS']) {
      expect(env).not.toHaveProperty(key)
      expect(process.env[key]).toBe('inherited-override')
    }
    expect(process.env.NODE_ENV).toBe('development')
    expect(process.env.PI_CODING_AGENT_DIR).toBe('/real/agent')
    expect(process.env.PHOSPHOR_E2E_SHOW).toBe('0')
  })

  it('propagates setup failures before creating the agent directory', async () => {
    vi.mocked(execFileSync).mockImplementation(() => {
      throw new Error('git failed')
    })
    await expect(prepareReadmeShots({ outDir: '/shots', piStub: '/pi-stub.cjs' })).rejects.toThrow(
      'git failed',
    )
    expect(execFileSync).toHaveBeenCalledTimes(1)
    expect(mkdtempSync).not.toHaveBeenCalled()
  })
})

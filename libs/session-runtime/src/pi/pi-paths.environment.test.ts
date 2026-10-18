import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeConfigDir,
  claudeProjectDirForCwd,
  claudeProjectDirName,
  claudeProjectsRoot,
  claudeSessionFileForCwd,
  clearRealCwdCache,
  webSearchConfigPath,
} from './pi-paths'

const home = '/injected/home'
const cwd = '/phosphor-path-environment/.claude/project_name'
const projectName = '-phosphor-path-environment--claude-project-name'

beforeEach(() => {
  vi.stubEnv('PI_CODING_AGENT_DIR', '/process/agent')
  vi.stubEnv('XDG_CONFIG_HOME', '/process/xdg')
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/process/claude')
})

afterEach(() => {
  vi.unstubAllEnvs()
  clearRealCwdCache()
})

describe('webSearchConfigPath injected environment', () => {
  it.each([
    { env: {}, expected: join(home, '.pi', 'web-search.json') },
    {
      env: { PI_CODING_AGENT_DIR: '/agent', XDG_CONFIG_HOME: '/xdg' },
      expected: join('/agent', 'web-search.json'),
    },
    { env: { XDG_CONFIG_HOME: '/xdg' }, expected: join('/xdg', 'pi', 'web-search.json') },
    {
      env: { PI_CODING_AGENT_DIR: '', XDG_CONFIG_HOME: '/xdg' },
      expected: join('/xdg', 'pi', 'web-search.json'),
    },
    {
      env: { PI_CODING_AGENT_DIR: '', XDG_CONFIG_HOME: '' },
      expected: join(home, '.pi', 'web-search.json'),
    },
  ])('resolves $env without reading process overrides', ({ env, expected }) => {
    expect(webSearchConfigPath(env, home)).toBe(expected)
  })
})

describe('Claude paths injected environment', () => {
  it.each([
    { env: {}, config: join(home, '.claude') },
    { env: { CLAUDE_CONFIG_DIR: '/injected/claude' }, config: '/injected/claude' },
    { env: { CLAUDE_CONFIG_DIR: '' }, config: '' },
    {
      env: { PI_CODING_AGENT_DIR: '/agent', XDG_CONFIG_HOME: '/xdg' },
      config: join(home, '.claude'),
    },
  ])('propagates $env through roots, projects and files', ({ env, config }) => {
    const root = join(config, 'projects')
    const project = join(root, projectName)
    expect(claudeConfigDir(env, home)).toBe(config)
    expect(claudeProjectsRoot(env, home)).toBe(root)
    expect(claudeProjectDirForCwd(cwd, env, home)).toBe(project)
    expect(claudeSessionFileForCwd(cwd, 'session-id', env, home)).toBe(
      join(project, 'session-id.jsonl'),
    )
  })

  it('preserves real-cwd resolution and caching across injected environments', () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'pi-paths-env-')))
    const target = join(root, 'target')
    const link = join(root, 'link')
    try {
      mkdirSync(target)
      symlinkSync(target, link)
      const name = claudeProjectDirName(target)
      expect(claudeProjectDirForCwd(link, {}, home)).toBe(join(home, '.claude', 'projects', name))
      unlinkSync(link)
      expect(
        claudeSessionFileForCwd(link, 'cached', { CLAUDE_CONFIG_DIR: '/other/claude' }, home),
      ).toBe(join('/other/claude', 'projects', name, 'cached.jsonl'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

it('defaults only the omitted environment or home argument', () => {
  expect(webSearchConfigPath(undefined, home)).toBe(join('/process/agent', 'web-search.json'))
  expect(claudeConfigDir(undefined, home)).toBe('/process/claude')
  expect(claudeSessionFileForCwd(cwd, 'id', undefined, home)).toBe(
    join('/process/claude', 'projects', projectName, 'id.jsonl'),
  )
  expect(webSearchConfigPath({})).toBe(join(homedir(), '.pi', 'web-search.json'))
  expect(claudeConfigDir({})).toBe(join(homedir(), '.claude'))
  expect(claudeProjectsRoot({})).toBe(join(homedir(), '.claude', 'projects'))
  expect(claudeProjectDirForCwd(cwd, {})).toBe(join(homedir(), '.claude', 'projects', projectName))
  expect(claudeSessionFileForCwd(cwd, 'id', {})).toBe(
    join(homedir(), '.claude', 'projects', projectName, 'id.jsonl'),
  )
})

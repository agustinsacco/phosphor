import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  claudeConfigDir,
  claudeProjectDirForCwd,
  claudeProjectDirName,
  claudeProjectsRoot,
  claudeSessionFileForCwd,
  piAgentDir,
  piSessionsRoot,
  sessionDirNameForCwd,
  webSearchConfigPath,
} from './pi-paths'

const home = homedir()

afterEach(() => vi.unstubAllEnvs())

describe('pi-paths process environment defaults', () => {
  it.each([
    {
      name: 'unset overrides use the home defaults',
      agent: undefined,
      xdg: undefined,
      claude: undefined,
      expectedAgent: join(home, '.pi', 'agent'),
      expectedWeb: join(home, '.pi', 'web-search.json'),
      expectedClaude: join(home, '.claude'),
    },
    {
      name: 'agent override wins over XDG and Claude has its own override',
      agent: '/custom/agent',
      xdg: '/custom/xdg',
      claude: '/custom/claude',
      expectedAgent: '/custom/agent',
      expectedWeb: join('/custom/agent', 'web-search.json'),
      expectedClaude: '/custom/claude',
    },
    {
      name: 'XDG applies only to web search',
      agent: undefined,
      xdg: '/custom/xdg',
      claude: undefined,
      expectedAgent: join(home, '.pi', 'agent'),
      expectedWeb: join('/custom/xdg', 'pi', 'web-search.json'),
      expectedClaude: join(home, '.claude'),
    },
    {
      name: 'empty agent falls through to XDG only for web search',
      agent: '',
      xdg: '/custom/xdg',
      claude: undefined,
      expectedAgent: '',
      expectedWeb: join('/custom/xdg', 'pi', 'web-search.json'),
      expectedClaude: join(home, '.claude'),
    },
    {
      name: 'empty XDG falls through to home',
      agent: undefined,
      xdg: '',
      claude: undefined,
      expectedAgent: join(home, '.pi', 'agent'),
      expectedWeb: join(home, '.pi', 'web-search.json'),
      expectedClaude: join(home, '.claude'),
    },
    {
      name: 'empty overrides retain nullish versus truthy precedence',
      agent: '',
      xdg: '',
      claude: '',
      expectedAgent: '',
      expectedWeb: join(home, '.pi', 'web-search.json'),
      expectedClaude: '',
    },
  ])('$name', ({ agent, xdg, claude, expectedAgent, expectedWeb, expectedClaude }) => {
    vi.stubEnv('PI_CODING_AGENT_DIR', agent)
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    vi.stubEnv('CLAUDE_CONFIG_DIR', claude)

    expect(piAgentDir()).toBe(expectedAgent)
    expect(piSessionsRoot()).toBe(join(expectedAgent, 'sessions'))
    expect(webSearchConfigPath()).toBe(expectedWeb)
    expect(claudeConfigDir()).toBe(expectedClaude)
    expect(claudeProjectsRoot()).toBe(join(expectedClaude, 'projects'))
    const cwd = '/phosphor-path-characterization/.claude/project_name'
    const project = join(
      expectedClaude,
      'projects',
      '-phosphor-path-characterization--claude-project-name',
    )
    expect(claudeProjectDirForCwd(cwd)).toBe(project)
    expect(claudeSessionFileForCwd(cwd, 'session-id')).toBe(join(project, 'session-id.jsonl'))
  })

  it('keeps an empty session-root override instead of falling back', () => {
    vi.stubEnv('PI_CODING_AGENT_DIR', '/custom/agent')
    vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', '')
    expect(piSessionsRoot()).toBe('')
  })

  it('keeps the distinct pi and Claude Windows mangling rules', () => {
    expect(sessionDirNameForCwd('C:\\Users\\dev\\my_proj')).toBe('--C--Users-dev-my_proj--')
    expect(claudeProjectDirName('C:\\Users\\dev\\my_proj')).toBe('C--Users-dev-my-proj')
  })
})

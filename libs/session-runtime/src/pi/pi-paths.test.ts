import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { piAgentDir, piSessionsRoot, sessionDirForCwd, sessionDirNameForCwd } from './pi-paths'

it('uses an injected environment and home without changing the directory rules', () => {
  expect(piAgentDir({}, '/home/test')).toBe('/home/test/.pi/agent')
  expect(piSessionsRoot({}, '/home/test')).toBe('/home/test/.pi/agent/sessions')
  expect(piSessionsRoot({ PI_CODING_AGENT_DIR: '/agent' }, '/home/test')).toBe('/agent/sessions')
  expect(
    piSessionsRoot(
      { PI_CODING_AGENT_SESSION_DIR: '/sessions', PI_CODING_AGENT_DIR: '/agent' },
      '/home/test',
    ),
  ).toBe('/sessions')
})
it('uses an explicit session root while the default still follows piSessionsRoot', () => {
  const cwd = realpathSync.native(mkdtempSync(join(tmpdir(), 'host-pi-paths-')))
  try {
    const name = sessionDirNameForCwd(cwd)
    expect(sessionDirForCwd(cwd, join(cwd, 'sessions'))).toBe(join(cwd, 'sessions', name))
    expect(sessionDirForCwd(cwd)).toBe(join(piSessionsRoot(), name))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

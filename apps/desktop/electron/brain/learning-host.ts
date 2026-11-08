import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createLearningHost } from '@phosphor/brain-runtime/learning-host'
import type { BrainLearningHost } from '@phosphor/brain-runtime/learning-port'
import { piAgentDir, piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { readLearningSourceBinding } from '@phosphor/brain-runtime/learning-source-binding'
import { registry } from '../registry'
import { desktopSessions } from '../pi/session-runtime'
import { sessionPaths } from '../pi/session-path-lock'
import { resolveBinary, windowsWhereOutput } from '../pi/binary-lookup'
import { resolveWindowsLaunch } from '../pi/win-launch'
import { getLoginShellPath } from '../pi/shell-env'
import { piStubPath } from '../pi/stub'
import { log } from '../debug-log'

/** Local Desktop only. Host/PWA never activate this private authenticated process capability. */
export function createDesktopLearningHost(options: {
  directory: string
  extensionPath: string
}): BrainLearningHost {
  return createLearningHost({
    ...options,
    registry,
    sessions: desktopSessions,
    paths: sessionPaths,
    sessionsRoot: piSessionsRoot(),
    onError: (error) => log('brain', 'Learning cleanup failed', { error: error.message }),
    resolve: async (selection, target, liveSessionId, signal, source) => {
      signal.throwIfAborted()
      if (piStubPath()) throw new Error('Learning is unavailable with the ordinary pi test stub')
      if (selection.provider === 'pi-claude-cli')
        throw new Error(
          'Learning CLI source identity hook is unavailable; an account assignment cannot attest actual process identity',
        )
      const sourceBinding = liveSessionId
        ? await readLearningSourceBinding(
            { registry, paths: sessionPaths, sessionsRoot: piSessionsRoot() },
            target,
            liveSessionId,
            source,
            signal,
          )
        : undefined
      const launch = await learningExecutable()
      // No piProcessEnv/login-shell env dump, harvested OAuth or copied API key. pi keeps its
      // existing config/store and provider-owned refresh. Environment-only auth fails closed.
      const env: Record<string, string> = { HOME: homedir() }
      for (const key of [
        'PATH',
        'USERPROFILE',
        'TMPDIR',
        'TEMP',
        'TMP',
        'SystemRoot',
        'WINDIR',
        'PI_MANAGED_INSTALL_ROOT',
        'CLAUDE_CONFIG_DIR',
      ]) {
        if (process.env[key] !== undefined) env[key] = process.env[key]!
      }
      if (process.platform !== 'win32')
        env.PATH = (await getLoginShellPath()) ?? env.PATH ?? '/usr/bin:/bin'
      signal.throwIfAborted()
      return { ...launch, agentDir: piAgentDir(), env, sourceBinding }
    },
  })
}
async function learningExecutable(): Promise<{ binaryPath: string; prefixArgs?: string[] }> {
  if (process.platform !== 'win32') {
    const binaryPath = await resolveBinary('pi')
    if (!binaryPath)
      throw new Error('Learning requires an installed pi >=1.4 with bound-request support')
    return { binaryPath }
  }
  const found = await resolveWindowsLaunch(await windowsWhereOutput('pi'), {
    readShim: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    whereNode: () => windowsWhereOutput('node'),
  })
  if (!found.ok) throw new Error('Learning pi executable is unavailable')
  return { binaryPath: found.launch.file, prefixArgs: found.launch.prefixArgs }
}

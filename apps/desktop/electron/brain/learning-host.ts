import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createLearningHost } from '@phosphor/brain-runtime/learning-host'
import type { BrainLearningHost } from '@phosphor/brain-runtime/learning-port'
import { piAgentDir, piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { registry } from '../registry'
import { desktopSessions } from '../pi/session-runtime'
import { sessionPaths } from '../pi/session-path-lock'
import { getClaudeAccountPrefs } from '../store'
import { resolveBinary, windowsWhereOutput } from '../pi/binary-lookup'
import { resolveWindowsLaunch } from '../pi/win-launch'
import { getLoginShellPath } from '../pi/shell-env'
import { piStubPath } from '../pi/stub'
import { log } from '../debug-log'
import { qualifyLearningClaudePackage, selectLearningClaudeAccount } from './learning-auth'

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
    resolve: async (selection, target, liveSessionId, signal) => {
      signal.throwIfAborted()
      if (piStubPath()) throw new Error('Learning is unavailable with the ordinary pi test stub')
      if (liveSessionId)
        throw new Error(
          'Live learning requires source-process metadata-only get_auth_binding including authIdentityFence; stock pi get_state and explicit Claude assignment IDs cannot attest a live credential epoch. No current-slot substitution is permitted.',
        )
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
      const native = { ...launch, agentDir: piAgentDir(), env }
      if (selection.provider !== 'pi-claude-cli') {
        signal.throwIfAborted()
        return native
      }
      const account = selectLearningClaudeAccount(getClaudeAccountPrefs(), target.sessionPath)
      const provider = qualifyLearningClaudePackage(await listPackages(target.workspacePath))
      signal.throwIfAborted()
      return {
        ...native,
        ...provider,
        accountId: account.accountId,
        env: {
          ...env,
          ...account.env,
          PI_CLAUDE_CLI_CONTEXT: 'pi',
          PI_CLAUDE_CLI_KEEPALIVE_MS: '0',
          PI_CLAUDE_CLI_EPHEMERAL: '1',
        },
      }
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

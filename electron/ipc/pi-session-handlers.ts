import { registry } from '../registry'
import { handle } from './handle'
import { spawnSession } from '../pi/session-runtime'
import {
  isRoutineSession,
  observeRoutineSession,
  routineSessionForPath,
} from '../routines/ownership'
import { checkPiHealth } from '../pi/health'
import { piStubPath } from '../pi/stub'
import { runPrintMode } from '../pi/print-mode'
import { piProcessEnv } from '../pi/shell-env'
import { dedupeTitle, sanitizeTitle, titleArgs, titlePrompt } from '../pi/session-naming'
import { claudeAccountEnv, primaryAccount } from '../claude/accounts'
import { forgetSpawnAccount } from '../pi/session-accounts'
import {
  claudeOneShotEnv,
  assertClaudeContextProvider,
  usesClaudeCliProvider,
} from '../pi/provider-detect'
import { readAgentSettings } from '../pi/agent-settings'
import { applyCompactionOwnership } from '../pi/compaction-ownership'
import { listPackages } from '../pi/packages'
import { getLanePrefs } from '../store'
import { MIN_PI_VERSION, type CreateSessionOptions, type PiHealth } from '@shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@shared/rpc'
import { log } from '../debug-log'

let cachedHealth: PiHealth | null = null

/** pi subprocess lifecycle: health, session create/dispose, RPC passthrough. */
export function registerPiSessionHandlers(): void {
  handle('pi:health', async () => {
    if (piStubPath()) {
      return {
        ok: true,
        binaryPath: piStubPath(),
        version: MIN_PI_VERSION,
        minVersion: MIN_PI_VERSION,
      }
    }
    if (!cachedHealth || !cachedHealth.ok) {
      cachedHealth = await checkPiHealth()
      // One line per fresh probe, beside the spawn argv this log already
      // records: on Windows this is the only place that shows WHICH node.exe
      // and entry script the launcher settled on (win-launch.ts), and it is
      // what the packaged-app smoke in CI asserts on.
      const { message: _message, ...facts } = cachedHealth
      log('pi', 'health', facts)
    }
    return cachedHealth
  })

  handle('pi:createSession', (event, options: CreateSessionOptions) => {
    // Opening a running routine's transcript must adopt its process, never
    // create a second writer for the same pi file.
    const ownedId = options.sessionPath ? routineSessionForPath(options.sessionPath) : undefined
    const owned = ownedId ? registry.get(ownedId) : undefined
    if (owned)
      return {
        sessionId: owned.sessionId,
        workspacePath: owned.workspacePath,
        pid: owned.client.pid,
      }
    return spawnSession(options, event.sender)
  })

  handle('pi:command', async (_event, sessionId: string, command: RpcCommand) => {
    const session = registry.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    if (command.type === 'get_messages') observeRoutineSession(sessionId)
    if (
      isRoutineSession(sessionId) &&
      ![
        'get_state',
        'get_messages',
        'get_session_stats',
        'get_available_models',
        'get_commands',
      ].includes(command.type)
    ) {
      throw new Error(
        'This lane is owned by a running routine. Cancel it from Routines before continuing manually.',
      )
    }
    if (!piStubPath()) {
      if (command.type === 'set_model' && command.provider === 'pi-claude-cli') {
        assertClaudeContextProvider(await listPackages(session.workspacePath))
      }
      // Spawn-time prediction cannot resolve pi's fuzzy model patterns. Verify
      // the actual provider before a prompt can run against an old package.
      if (command.type === 'prompt') {
        const state = await session.client.request({ type: 'get_state' })
        if (!state.success || !state.data) throw new Error('Cannot verify the active pi model.')
        if (state.data.model?.provider === 'pi-claude-cli') {
          assertClaudeContextProvider(await listPackages(session.workspacePath))
        }
      }
    }
    const response = await session.client.request(command)
    // The provider may have changed under the session, and with it who owns
    // compaction (electron/pi/compaction-ownership.ts). Re-read rather than
    // trust the command's own provider field: pi resolves fuzzy patterns.
    if (command.type === 'set_model' && response.success && !piStubPath()) {
      await applyCompactionOwnership(session.client).catch((error: unknown) => {
        log('pi', 'compaction ownership not applied after set_model', {
          sessionId,
          error: String(error),
        })
      })
    }
    return response
  })

  handle('pi:extensionUiResponse', (_event, sessionId: string, response: ExtensionUIResponse) => {
    const session = registry.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.client.respondToExtensionUI(response)
  })

  handle('pi:disposeSession', async (_event, sessionId: string) => {
    if (isRoutineSession(sessionId))
      throw new Error('Cancel the active run from Routines before closing its lane.')
    forgetSpawnAccount(sessionId)
    await registry.dispose(sessionId)
  })

  handle('pi:listLiveSessions', () => registry.list())

  // Best-effort: naming is a nicety, so every failure path returns null and
  // the session keeps its first-message-derived title.
  handle(
    'pi:generateTitle',
    async (_event, workspacePath: string, message: string, existingNames: string[]) => {
      const lanePrefs = getLanePrefs()
      const stub = piStubPath()
      let binaryPath: string
      let prefixArgs: string[]
      let env: NodeJS.ProcessEnv
      if (stub) {
        binaryPath = process.execPath
        prefixArgs = [stub]
        env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      } else {
        const health = cachedHealth?.ok ? cachedHealth : (cachedHealth = await checkPiHealth())
        if (!health.ok || !health.binaryPath) return null
        binaryPath = health.binaryPath
        prefixArgs = health.prefixArgs ?? []
        env = {
          ...process.env,
          ...(await piProcessEnv()),
          // Naming-only override: a title run through the Claude provider
          // should not load Claude Code's own prompt, skills, MCP servers or
          // settings — it never calls a tool, so there is no native-tool
          // guidance to lose by replacing the prompt outright. Real sessions
          // don't get this override; see the comment above spawnEnv. Harmless
          // env for every other provider. Measured saving: ~8,000 tokens per
          // run.
          PI_CLAUDE_CLI_HERMETIC: '1',
          PI_CLAUDE_CLI_SYSTEM_PROMPT: 'pi',
          // Without this the run prints the title and then hangs until
          // runPrintMode kills it — see claudeOneShotEnv.
          ...claudeOneShotEnv(),
        }
      }

      // `--no-session` keeps this run out of the sidebar; `--no-tools`
      // keeps a title request from being able to touch anything; the rest of
      // `titleArgs` keeps a five-word title from paying for a full session's
      // context. Spawned through runPrintMode because `pi -p` blocks until
      // stdin hits EOF — see electron/pi/print-mode.ts, and never
      // reintroduce execFile here.
      const claudeCli = stub
        ? false
        : usesClaudeCliProvider({}, (await readAgentSettings(workspacePath)).defaultProvider)
      // A naming run bills a plan too, so it goes to the account the user
      // pinned (or the first one) rather than to whatever the CLI's default
      // keychain entry happens to hold. Only asked for on the Claude path:
      // resolving it costs two `claude` spawns on an install that has never
      // stored an account, and a title run is on the session-start path.
      if (claudeCli) {
        Object.assign(env, claudeAccountEnv(await primaryAccount().catch(() => null)))
      }
      const started = Date.now()
      const { stdout, error } = await runPrintMode(
        binaryPath,
        [
          ...prefixArgs,
          ...titleArgs({ claudeCli }),
          titlePrompt(message, existingNames, {
            min: lanePrefs.nameMinWords,
            max: lanePrefs.nameMaxWords,
          }),
        ],
        { cwd: workspacePath, env },
      )
      const title = stdout ? sanitizeTitle(stdout, lanePrefs.nameMaxLength) : null
      // Logged either way: this failing produced no symptom at all for weeks
      // beyond "sessions are never named", which named no cause. One line per
      // new chat is a price worth paying for that never happening again.
      log('naming', title ? 'generated a session name' : 'no session name', {
        ms: Date.now() - started,
        title,
        ...(error ? { error } : {}),
      })
      return title ? dedupeTitle(title, existingNames) : null
    },
  )
}

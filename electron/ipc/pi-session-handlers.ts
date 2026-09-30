import { access } from 'node:fs/promises'
import { registry } from '../registry'
import { sessionPathKey, openSessionPath } from '../pi/session-path-lock'
import { handle } from './handle'
import { spawnSession } from '../pi/session-runtime'
import {
  isRoutineSession,
  observeRoutineSession,
  routineSessionForPath,
} from '../routines/ownership'
import { cachedAgentHealth } from '../pi/health'
import { OMP_TITLE_ARGS } from '../pi/omp-dialect'
import { piStubPath } from '../pi/stub'
import { runPrintMode } from '../pi/print-mode'
import { piProcessEnv } from '../pi/shell-env'
import { dedupeTitle, sanitizeTitle, titleArgs, titlePrompt } from '../pi/session-naming'
import { claudeAccountEnv, primaryAccount } from '../claude/accounts'
import { forgetSpawnAccount } from '../pi/session-accounts'
import {
  claudeOneShotEnv,
  claudeProviderSpawnEnv,
  assertClaudeContextProvider,
  usesClaudeCliProvider,
} from '../pi/provider-detect'
import { readAgentSettings } from '../pi/agent-settings'
import { syncContextBudget, withBudgetCompaction } from '../pi/context-budget'
import { getPrefs } from '../store'
import { listPackages } from '../pi/packages'
import { getLanePrefs } from '../store'
import { MIN_PI_VERSION, type AgentKind, type CreateSessionOptions } from '@shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@shared/rpc'
import { log } from '../debug-log'

/** Agent subprocess lifecycle: health, session create/dispose, RPC passthrough. */
export function registerPiSessionHandlers(): void {
  // The agent sessions spawn (Settings → Advanced → Agent). The setup screen
  // gates the whole app on this, so it is the SELECTED agent's health, never
  // pi's when omp is chosen.
  handle('pi:health', async () => {
    if (piStubPath()) {
      return {
        ok: true,
        agent: 'pi' as const,
        binaryPath: piStubPath(),
        version: MIN_PI_VERSION,
        minVersion: MIN_PI_VERSION,
      }
    }
    return cachedAgentHealth()
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
    if (!options.sessionPath) return spawnSession(options, event.sender)
    const path = sessionPathKey(options.sessionPath)
    return openSessionPath(path, async (signal) => {
      const matches = registry
        .list()
        .filter((s) => s.diskPath && sessionPathKey(s.diskPath) === path)
      const live = matches.find((s) => registry.get(s.sessionId)?.client.alive)
      if (live) return live
      // A crashed handle must not prevent a genuine resume.
      for (const session of matches) await registry.dispose(session.sessionId)
      // pi creates a new session for a missing --session file. After a delete,
      // a queued open must fail instead of silently recreating that lane.
      await access(path)
      signal.throwIfAborted()
      return spawnSession({ ...options, sessionPath: path }, event.sender, { signal })
    })
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
    return withBudgetCompaction(sessionId, command.type, async () => {
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
          await syncContextBudget(session.client, getPrefs().contextBudget)
        }
      }
      const result = await session.client.request(command)
      if (!piStubPath() && command.type === 'set_auto_compaction' && result.success) {
        await syncContextBudget(session.client, getPrefs().contextBudget)
      }
      return result
    })
  })

  handle('pi:extensionUiResponse', (_event, sessionId: string, response: ExtensionUIResponse) => {
    const session = registry.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.client.respondToExtensionUI(response)
  })

  handle('pi:disposeSession', async (_event, sessionId: string) => {
    if (isRoutineSession(sessionId)) {
      const { cancelRoutineSession } = await import('../routines')
      await cancelRoutineSession(sessionId)
    }
    forgetSpawnAccount(sessionId)
    await registry.dispose(sessionId)
  })

  handle('pi:listLiveSessions', () => registry.list())

  // A read, so a routine-owned lane answers it too. pi resolves empty in the
  // client without being asked.
  handle('pi:subagents', async (_event, sessionId: string) => {
    const session = registry.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session.client.getSubagents()
  })

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
      let agent: AgentKind = 'pi'
      if (stub) {
        binaryPath = process.execPath
        prefixArgs = [stub]
        env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      } else {
        const health = await cachedAgentHealth()
        if (!health.ok || !health.binaryPath) return null
        binaryPath = health.binaryPath
        prefixArgs = health.prefixArgs ?? []
        agent = health.agent
        env = {
          ...process.env,
          ...(await piProcessEnv()),
          // The pi ownership every session gets, so a title run on the Claude
          // provider loads none of Claude Code's own prompt, skills, MCP
          // servers or settings either. Harmless env for every other provider.
          ...claudeProviderSpawnEnv(),
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
      const claudeCli =
        stub || agent === 'omp'
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
          ...(agent === 'omp' ? OMP_TITLE_ARGS : titleArgs({ claudeCli })),
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

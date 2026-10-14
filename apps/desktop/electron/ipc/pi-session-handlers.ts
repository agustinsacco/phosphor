import { handle } from './handle'
import { remoteLanes } from './hosts-handlers'
import { isRemoteHandle } from '../hosts/remote-lanes'
import { desktopSessions } from '../pi/session-runtime'
import { checkPiHealth } from '../pi/health'
import { piStubPath } from '../pi/stub'
import { runPrintMode } from '../pi/print-mode'
import { piProcessEnv } from '../pi/shell-env'
import { dedupeTitle, sanitizeTitle, titleArgs, titlePrompt } from '../pi/session-naming'
import { claudeAccountEnv, primaryAccount } from '../claude/accounts'
import {
  claudeOneShotEnv,
  claudeProviderSpawnEnv,
  usesClaudeCliProvider,
} from '../pi/provider-detect'
import { readAgentSettings } from '@phosphor/session-runtime/pi/agent-settings'
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

  handle('pi:createSession', (event, options: CreateSessionOptions) =>
    desktopSessions.create(options, event.sender),
  )
  handle('pi:command', (event, sessionId: string, command: RpcCommand) =>
    isRemoteHandle(sessionId)
      ? remoteLanes().command(event.sender.id, sessionId, command)
      : desktopSessions.command(sessionId, command),
  )
  handle('pi:extensionUiResponse', (event, sessionId: string, response: ExtensionUIResponse) =>
    isRemoteHandle(sessionId)
      ? remoteLanes().respond(event.sender.id, sessionId, response)
      : desktopSessions.respond(sessionId, response),
  )
  handle('pi:disposeSession', (event, sessionId: string) =>
    isRemoteHandle(sessionId)
      ? remoteLanes().dispose(event.sender.id, sessionId)
      : desktopSessions.dispose(sessionId),
  )
  handle('pi:listLiveSessions', (event) => [
    ...desktopSessions.list(),
    ...remoteLanes().list(event.sender.id),
  ])

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

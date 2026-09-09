import { app } from 'electron'
import { basename, join as joinPath } from 'node:path'
import { registry } from '../registry'
import { handle } from './handle'
import { trimForRenderer } from './event-trim'
import { checkPiHealth } from '../pi/health'
import { piStubPath } from '../pi/stub'
import { runPrintMode } from '../pi/print-mode'
import { piProcessEnv } from '../pi/shell-env'
import { composeDirectives } from '../pi/directives'
import { dedupeTitle, sanitizeTitle, titleArgs, titlePrompt } from '../pi/session-naming'
import { accountForSpawn, claudeAccountEnv, holdAccount, primaryAccount } from '../claude/accounts'
import { RATE_LIMIT_STATUS_KEY, accountExhaustedUntil } from '@shared/claude-limits'
import { forgetSpawnAccount, rememberSpawnAccount } from '../pi/session-accounts'
import {
  claudeOneShotEnv,
  claudeProviderSpawnEnv,
  assertClaudeContextProvider,
  usesClaudeCliProvider,
} from '../pi/provider-detect'
import { readAgentSettings } from '../pi/agent-settings'
import { listPackages } from '../pi/packages'
import { headroomSupervisor } from '../headroom/proxy'
import { sessionEventChannel } from '@shared/ipc'
import { getPrefs, recordWorkspace, getLanePrefs } from '../store'
import { gitInfoBatch } from '../fs/git-info'
import {
  MIN_PI_VERSION,
  type CreateSessionOptions,
  type LiveSessionInfo,
  type PiHealth,
  type SessionPush,
} from '@shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@shared/rpc'
import { log } from '../debug-log'

let cachedHealth: PiHealth | null = null

/** Bundled Phosphor pi extension (dev: repo path; packaged: resources). */
function bundledExtensionPath(file: string): string {
  if (app.isPackaged) {
    return joinPath(process.resourcesPath, 'pi-ext', file)
  }
  return joinPath(app.getAppPath(), 'pi-ext', file)
}

/**
 * Extensions Phosphor loads into EVERY session, regardless of provider:
 * artifacts (tools the model can call), context-breakdown (passive reporting
 * of what is filling the context window, which only pi can see),
 * worktree-paths (refuses a file read that has escaped into the main
 * checkout of a worktree session), tool-name-guard (keeps a malformed
 * tool call out of the session file, where it would brick every later turn),
 * mcp-status (per-server MCP state for the connectors UI), and headroom
 * (compresses large tool results through the local Headroom proxy as they
 * are produced; inert unless PHOSPHOR_HEADROOM_URL is set at spawn).
 *
 * All six files in pi-ext/ are listed here — keep this comment and the array
 * in step, since nothing else records why a given one is loaded.
 */
function bundledExtensions(): string[] {
  return [
    bundledExtensionPath('artifacts.ts'),
    bundledExtensionPath('context-breakdown.ts'),
    bundledExtensionPath('worktree-paths.ts'),
    bundledExtensionPath('tool-name-guard.ts'),
    bundledExtensionPath('mcp-status.ts'),
    bundledExtensionPath('headroom.ts'),
  ]
}

/**
 * Spawn a live session and wire its push channels.
 */
async function spawnSession(
  options: CreateSessionOptions,
  target: Electron.WebContents,
): Promise<LiveSessionInfo> {
  const stub = piStubPath()
  let binaryPath: string | undefined
  let prefixArgs: string[] | undefined

  if (stub) {
    binaryPath = process.execPath
    prefixArgs = [stub]
  } else {
    const health = cachedHealth?.ok ? cachedHealth : (cachedHealth = await checkPiHealth())
    if (!health.ok) throw new Error(health.message ?? 'pi is not available')
    binaryPath = health.binaryPath
  }

  // pi is a `#!/usr/bin/env node` script: it needs the login shell's PATH
  // to find node under a version manager, not the GUI-inherited one.
  //
  // No PI_CLAUDE_CLI_SYSTEM_PROMPT override here: real sessions always run
  // pi-claude-cli's own default (`claude` mode, appends pi's prompt to Claude
  // Code's own). This used to be a Phosphor setting; dropped because the only
  // upside of the alternative (`pi` mode, replacing Claude Code's prompt
  // outright) is ~12k tokens of context WINDOW, not cost — both modes are
  // cached — at the cost of losing Claude Code's own tuned guidance for the
  // native tools this provider actually runs. Not worth doubling the number
  // of system-prompt code paths that have to reach the model correctly — the
  // one path has already been silently broken twice: the CLI dropped
  // `--system-prompt` across `--resume`, and it takes a literal string where
  // the provider was passing a temp-file path, so pi's instructions never
  // reached Claude Code at all. The naming call below keeps its own internal
  // `pi` override — a no-tools, no-guidance-needed case.
  // Claude Code auto-compact window (Settings → Claude Code → Context
  // window). Read per spawn so a change applies to the next session started
  // without restarting Phosphor; unset means the provider's own default (200k),
  // so the env var is only set when the user chose something.
  const claudeAutocompact = getPrefs().claudeAutocompact
  const spawnEnv: Record<string, string> = stub
    ? { ELECTRON_RUN_AS_NODE: '1' }
    : {
        ...(await piProcessEnv()),
        ...claudeProviderSpawnEnv(),
        ...(claudeAutocompact ? { PI_CLAUDE_CLI_AUTOCOMPACT: claudeAutocompact } : {}),
      }

  const extensions = [...bundledExtensions()]

  // Worktree sessions get an explicit working-directory block: pi's own
  // `Current working directory:` line is correct but has been observed to
  // lose against a model rebuilding an absolute path from what it thinks
  // the project root is. Skipped for the stub, which speaks a fixed script.
  // The batched form for one path on purpose: it is the cached one, and the
  // sidebar has almost always just resolved this cwd, so creating a session
  // usually costs no git at all.
  const gitByPath = stub ? {} : await gitInfoBatch([options.workspacePath])
  const git = gitByPath[options.workspacePath] ?? { isRepo: false }
  // Layer 2 of the directive stack. `directives.ts` owns the order and the
  // reasoning; this only resolves which prefs apply. Per-project overrides key
  // on the repo of record, so every worktree of a repo gets the same rules.
  const projectKey = git.mainRepoPath ?? options.workspacePath
  const prefs = getPrefs()
  const directivePrefs = prefs.agentDirectivesByProject[projectKey] ?? prefs.agentDirectives
  const appendSystemPrompt = composeDirectives({
    cwd: options.workspacePath,
    git,
    prefs: directivePrefs,
    // Present only for a lane on its own branch. A session opened in the main
    // checkout is not a lane and is not told it owes a PR.
    ...(git.isWorktree && git.branch ? { charter: { branch: git.branch } } : {}),
  })

  // pi loads project context for EVERY provider. The Claude context policy
  // disables the CLI's second loader without replacing its native tools or
  // default prompt. Gate the separately installed provider before relying on
  // that policy; older versions silently ignore the new environment variable.
  const claudeProvider = stub
    ? false
    : usesClaudeCliProvider(
        options,
        (await readAgentSettings(options.workspacePath)).defaultProvider,
      )
  if (claudeProvider) assertClaudeContextProvider(await listPackages(options.workspacePath))

  // Which Claude login bills this session (Settings -> Claude Code ->
  // Accounts). One env var on the pi spawn is enough: pi-claude-cli spawns the
  // CLI with `{ ...process.env }`, and 0.7.0 keeps ONE CLI process per session,
  // so the credential is fixed for the session's whole life. Chosen here and
  // not later for exactly that reason — see electron/claude/routing.ts.
  const claudeAccount = claudeProvider
    ? await accountForSpawn({
        ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}),
      }).catch(() => null)
    : null
  if (claudeAccount) Object.assign(spawnEnv, claudeAccountEnv(claudeAccount))

  // Headroom compression (Settings → Optimization). Set only when the managed
  // proxy is believed healthy — the bundled extension is inert without the
  // URL, and fails open even with a stale one. Env-only integration on
  // purpose: Phosphor never writes provider config for a proxy.
  if (!stub) Object.assign(spawnEnv, headroomSupervisor().sessionEnv())

  const session = registry.create(options.workspacePath, {
    binaryPath,
    prefixArgs,
    sessionPath: options.sessionPath,
    forkFrom: options.forkFrom,
    name: options.name,
    model: options.model,
    provider: options.provider,
    thinkingLevel: options.thinkingLevel,
    ...(appendSystemPrompt ? { appendSystemPrompt } : {}),
    // The bundled artifacts extension rides along in every session.
    ...(stub ? {} : { extensions }),
    env: spawnEnv,
  })

  const channel = sessionEventChannel(session.sessionId)
  const push = (payload: SessionPush): void => {
    if (!target.isDestroyed()) target.send(channel, payload)
  }

  // Trimmed, not forwarded whole: two of pi's events restate the entire run
  // after it has already streamed, and the renderer reads neither.
  session.client.on('event', (ev) => push({ kind: 'event', event: trimForRenderer(ev) }))
  session.client.on('extension-ui', (request) => {
    // The Claude provider reports its account's rate-limit state here, once
    // per change, for free. Routing listens because this is the only signal
    // that names the state `/usage` polling cannot: allowance gone, requests
    // still served, every token now billed as overage. Holding the account
    // here is what makes the NEXT lane pick a different one — this session's
    // credential was fixed when it spawned and cannot move (routing.ts).
    if (
      claudeAccount &&
      request.method === 'setStatus' &&
      request.statusKey === RATE_LIMIT_STATUS_KEY
    ) {
      const until = accountExhaustedUntil(request.statusText)
      if (until !== null) void holdAccount(claudeAccount.id, until).catch(() => undefined)
    }
    push({ kind: 'extension-ui', request })
  })
  session.client.on('stderr', (text) => {
    // Persist as well as forward. pi's stderr is where a provider prints the
    // reason a turn failed, and forwarding it to the renderer alone means it
    // is gone the moment the view unmounts — which is exactly what made
    // `Error: Claude CLI returned success` so expensive to diagnose.
    log('pi', 'stderr', { sessionId: session.sessionId, text })
    push({ kind: 'stderr', text })
  })
  session.client.on('exit', ({ code, signal, expected }) => {
    // An unexpected exit is what the user sees as "pi crashed"; without this
    // the code and signal behind that banner are never written down.
    if (!expected) {
      log('pi', 'exited unexpectedly', { sessionId: session.sessionId, code, signal })
    }
    push({ kind: 'exit', code, signal: signal ?? null, expected })
  })

  // Parked until the renderer learns the session's file path; see
  // electron/pi/session-accounts.ts.
  if (claudeAccount) rememberSpawnAccount(session.sessionId, claudeAccount.id)

  recordWorkspace(options.workspacePath, basename(options.workspacePath))
  return {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    pid: session.client.pid,
  }
}

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
    if (!cachedHealth || !cachedHealth.ok) cachedHealth = await checkPiHealth()
    return cachedHealth
  })

  handle('pi:createSession', (event, options: CreateSessionOptions) =>
    spawnSession(options, event.sender),
  )

  handle('pi:command', async (_event, sessionId: string, command: RpcCommand) => {
    const session = registry.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
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
    return session.client.request(command)
  })

  handle('pi:extensionUiResponse', (_event, sessionId: string, response: ExtensionUIResponse) => {
    const session = registry.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    session.client.respondToExtensionUI(response)
  })

  handle('pi:disposeSession', async (_event, sessionId: string) => {
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
      let prefixArgs: string[] = []
      let env: NodeJS.ProcessEnv
      if (stub) {
        binaryPath = process.execPath
        prefixArgs = [stub]
        env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      } else {
        const health = cachedHealth?.ok ? cachedHealth : (cachedHealth = await checkPiHealth())
        if (!health.ok || !health.binaryPath) return null
        binaryPath = health.binaryPath
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

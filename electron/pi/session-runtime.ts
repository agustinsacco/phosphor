import { app } from 'electron'
import { basename, join as joinPath } from 'node:path'
import { registry } from '../registry'
import { trimForRenderer } from '../ipc/event-trim'
import { checkPiHealth } from './health'
import { piStubPath } from './stub'
import { piProcessEnv } from './shell-env'
import { composeDirectives } from './directives'
import { accountForSpawn, claudeAccountEnv, holdAccount } from '../claude/accounts'
import { RATE_LIMIT_STATUS_KEY, accountExhaustedUntil } from '@shared/claude-limits'
import { rememberSpawnAccount } from './session-accounts'
import {
  claudeProviderSpawnEnv,
  assertClaudeContextProvider,
  usesClaudeCliProvider,
} from './provider-detect'
import { readAgentSettings } from './agent-settings'
import { applyCompactionOwnership } from './compaction-ownership'
import { realignSessionCwd } from './session-cwd'
import { listPackages } from './packages'
import { headroomSupervisor } from '../headroom/proxy'
import { sessionEventChannel } from '@shared/ipc'
import { getPrefs, recordWorkspace, realPathOrNull } from '../store'
import { gitInfoBatch } from '../fs/git-info'
import type { CreateSessionOptions, LiveSessionInfo, PiHealth, SessionPush } from '@shared/models'
import { log } from '../debug-log'
import { broadcast } from '../broadcast'

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
export async function spawnSession(
  rawOptions: CreateSessionOptions,
  target?: Electron.WebContents,
  execution: { unattended?: boolean; intent?: 'report' | 'code'; signal?: AbortSignal } = {},
): Promise<LiveSessionInfo> {
  // Resolved before anything reads it. This one value becomes pi's cwd, the
  // registry key, the recents entry and the `workspacePath` the renderer holds
  // for a LIVE session — and the sidebar keys its groups by that string. A
  // session started under a second spelling of a folder (any symlink on the
  // way to it) therefore opened a second group listing the same lanes, even
  // once recents themselves had been de-duplicated, because the live session
  // put the other spelling back. pi resolves the cwd for its session directory
  // regardless, so this only makes Phosphor agree with what pi already did.
  const options: CreateSessionOptions = {
    ...rawOptions,
    workspacePath: realPathOrNull(rawOptions.workspacePath) ?? rawOptions.workspacePath,
  }
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
    // Windows: node.exe + pi's entry script (see shared/models.ts PiHealth).
    prefixArgs = health.prefixArgs
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
    ...(git.isWorktree && git.branch && execution.intent !== 'report'
      ? { charter: { branch: git.branch } }
      : {}),
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

  // pi resumes into the cwd frozen in the session header, NOT the one it is
  // spawned with, and refuses outright when that folder is gone. Renaming a
  // sandbox moves every cwd under it, so this is the last moment the header
  // can be pointed back at the folder the file actually lives in — and the
  // only one where no pi process owns the file (see session-cwd.ts).
  // Best-effort: a file we could not rewrite still resumes exactly as before.
  if (options.sessionPath && !stub) {
    await realignSessionCwd(options.sessionPath, options.workspacePath).catch((error: unknown) => {
      log('pi', 'session cwd not realigned', {
        path: options.sessionPath,
        error: String(error),
      })
    })
  }

  execution.signal?.throwIfAborted()
  const session = registry.create(options.workspacePath, {
    ownProcessGroup: true,
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
    // Unattended dialogs belong to the runner's blocking policy, never the
    // renderer's OAuth auto-open flow. Display-only status still streams.
    if (
      execution.unattended &&
      payload.kind === 'extension-ui' &&
      ['input', 'confirm', 'select', 'editor'].includes(payload.request.method)
    )
      return
    if (target) {
      if (!target.isDestroyed()) target.send(channel, payload)
    } else broadcast(channel, payload)
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

  // One compactor per session (electron/pi/compaction-ownership.ts). Awaited
  // on purpose: the renderer bootstraps from get_state the moment this
  // returns, and the ⋮ menu must show the state this decided, not the one
  // pi started with. Spawn-time provider prediction is deliberately not used
  // here — pi's fuzzy model patterns resolve only once pi is up, and this
  // asks pi. The stub speaks a fixed script and is left alone.
  const stopOnAbort = (): void => {
    void registry.dispose(session.sessionId)
  }
  execution.signal?.addEventListener('abort', stopOnAbort, { once: true })
  if (execution.signal?.aborted) stopOnAbort()
  try {
    if (!stub) {
      await applyCompactionOwnership(session.client).catch((error: unknown) => {
        log('pi', 'compaction ownership not applied', {
          sessionId: session.sessionId,
          error: String(error),
        })
      })
    }
    execution.signal?.throwIfAborted()
    if (!session.client.alive) {
      await registry.dispose(session.sessionId)
      throw new Error('Session stopped during startup.')
    }
  } finally {
    execution.signal?.removeEventListener('abort', stopOnAbort)
  }

  // Parked until the renderer learns the session's file path; see
  // electron/pi/session-accounts.ts.
  if (claudeAccount) rememberSpawnAccount(session.sessionId, claudeAccount.id)

  // Background automation must not overwrite the user's launch-resume folder.
  if (!execution.unattended) recordWorkspace(options.workspacePath, basename(options.workspacePath))
  return {
    sessionId: session.sessionId,
    workspacePath: session.workspacePath,
    pid: session.client.pid,
  }
}

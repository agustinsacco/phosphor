import { handle } from './handle'
import { remoteLanes } from './hosts-handlers'
import { isRemoteHandle } from '../hosts/remote-lanes'
import { desktopSessions } from '../pi/session-runtime'
import { checkPiHealth } from '../pi/health'
import { piStubPath } from '../pi/stub'
import { runPrintMode } from '../pi/print-mode'
import { piProcessEnv } from '../pi/shell-env'
import {
  CLAUDE_TITLE_FALLBACK,
  dedupeTitle,
  pickTitleModel,
  sanitizeTitle,
  titleArgs,
  titleAttempts,
  titlePrompt,
  type TitleAttempt,
  type TitleModel,
} from '../pi/session-naming'
import { catalogueModels } from './pi-config-handlers'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
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

/** Providers whose title run failed under `-ne`: always boot them fully. */
const fullBootProviders = new Set<string>()
/** Picked title models that failed on this account: use the fallback. */
const unusableTitleModels = new Set<string>()

const modelKey = (model: TitleModel): string => `${model.provider}/${model.id}`

const sameModel = (a: TitleModel | null, b: TitleModel | null): boolean =>
  (a ? modelKey(a) : null) === (b ? modelKey(b) : null)

/**
 * Learn from the attempts that failed before `used` succeeded, so a setup
 * that cannot take the fast path pays for the failed run once per app launch,
 * not on every chat. Only learned from an eventual success: when everything
 * fails (offline, signed out) there is no telling what was at fault.
 */
function rememberTitleFailures(
  failed: TitleAttempt[],
  used: TitleAttempt,
  defaultProvider: string | undefined,
): void {
  for (const attempt of failed) {
    if (attempt.extensions && !used.extensions && sameModel(attempt.model, used.model)) {
      fullBootProviders.add(attempt.model?.provider ?? defaultProvider ?? '')
    }
    if (attempt.model && !sameModel(attempt.model, used.model)) {
      unusableTitleModels.add(modelKey(attempt.model))
    }
  }
}

/** How long a title waits for a cold model catalogue before using the default. */
const CATALOGUE_WAIT_MS = 4_000

/**
 * Which model to title on, and whether a fast `-ne` boot is possible.
 *
 * The catalogue is preloaded at boot, so this is usually a cache hit. The
 * provider's own extension is loaded on a fast boot for the one extension
 * provider Phosphor knows (pi-claude-cli); any other provider gets a bare
 * `-ne`, and `titleAttempts` retries with a full boot if it was not built in.
 */
async function planTitleRun(
  workspacePath: string,
  settings: { defaultProvider?: string; defaultModel?: string },
  fallback: TitleModel | null,
): Promise<TitleAttempt[]> {
  const catalogue = await Promise.race([
    catalogueModels().catch(() => []),
    new Promise<[]>((resolve) => setTimeout(() => resolve([]), CATALOGUE_WAIT_MS)),
  ])
  const picked = pickTitleModel(catalogue, settings.defaultProvider, settings.defaultModel)
  const model = picked && !unusableTitleModels.has(modelKey(picked)) ? picked : fallback
  const provider = model?.provider ?? settings.defaultProvider ?? ''
  let fast: string[] | null = fullBootProviders.has(provider) ? null : []
  if (fast && provider === 'pi-claude-cli') {
    const pkg = (await listPackages(workspacePath).catch(() => [])).find(
      (entry) => entry.name === '@saccolabs/pi-claude-cli' && entry.installed,
    )
    fast = pkg?.resources.extensions.length ? pkg.resources.extensions : null
  }
  return titleAttempts(model, fast, fallback)
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
      const settings: { defaultProvider?: string; defaultModel?: string } = stub
        ? {}
        : await readAgentSettings(workspacePath)
      const claudeCli = stub ? false : usesClaudeCliProvider({}, settings.defaultProvider)
      const fallback = claudeCli ? CLAUDE_TITLE_FALLBACK : null
      const plan = stub
        ? titleAttempts(null, null, null)
        : await planTitleRun(workspacePath, settings, fallback)
      // A naming run bills a plan too, so it goes to the account the user
      // pinned (or the first one) rather than to whatever the CLI's default
      // keychain entry happens to hold. Only asked for on the Claude path:
      // resolving it costs two `claude` spawns on an install that has never
      // stored an account, and a title run is on the session-start path.
      if (claudeCli) {
        Object.assign(env, claudeAccountEnv(await primaryAccount().catch(() => null)))
      }
      const prompt = titlePrompt(message, existingNames, {
        min: lanePrefs.nameMinWords,
        max: lanePrefs.nameMaxWords,
      })
      const started = Date.now()
      let title: string | null = null
      const errors: string[] = []
      for (const attempt of plan) {
        const { stdout, error } = await runPrintMode(
          binaryPath,
          [...prefixArgs, ...titleArgs(attempt), prompt],
          { cwd: workspacePath, env },
        )
        title = stdout ? sanitizeTitle(stdout, lanePrefs.nameMaxLength) : null
        if (title) break
        errors.push(error ?? 'empty reply')
        // A timeout is not a boot or model problem; another run would only
        // spend another 30s.
        if (error?.startsWith('timed out')) break
      }
      const used = title ? plan[errors.length] : undefined
      if (used) rememberTitleFailures(plan.slice(0, errors.length), used, settings.defaultProvider)
      // Logged either way: this failing produced no symptom at all for weeks
      // beyond "sessions are never named", which named no cause. One line per
      // new chat is a price worth paying for that never happening again.
      log('naming', title ? 'generated a session name' : 'no session name', {
        ms: Date.now() - started,
        title,
        model: used?.model ? modelKey(used.model) : 'default',
        fastBoot: Boolean(used?.extensions),
        ...(errors.length ? { errors } : {}),
      })
      return title ? dedupeTitle(title, existingNames) : null
    },
  )
}

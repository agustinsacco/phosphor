/**
 * Where an in-app `claude auth login` has got to.
 *
 * Deliberately not `LoginFlowState`: this is a different flow with a different
 * shape. pi's OAuth providers hand off to a browser and finish by themselves,
 * while the Claude CLI's handshake redirects to a page that shows a code the
 * user must paste back — so `awaiting-code` is a state the UI must collect
 * input in, not just wait in. See `apps/desktop/electron/pi/claude-login.ts`.
 */
export type ClaudeLoginState =
  | { phase: 'starting' }
  | {
      phase: 'awaiting-code'
      /** Authorization page. The CLI already opened it; this is the fallback link. */
      url: string
      /** The previous code was rejected and this URL is its replacement. */
      invalidCode?: boolean
    }
  /** Code submitted; waiting on the CLI to write credentials. */
  | { phase: 'finishing' }
  | { phase: 'signed-in'; email?: string }
  | { phase: 'cancelled' }
  | { phase: 'error'; message: string }

// ---------- subscription accounts ----------

/**
 * A provider pi can sign into with a consumer subscription rather than an
 * API key. The list is Phosphor's, not pi's: pi exposes no way to enumerate its
 * OAuth providers over RPC or the CLI, so these are curated from pi's
 * providers doc and each id is verified against `pi auth check`.
 */
/**
 * Providers pi offers under "Sign in with an account", as of pi 0.84.1.
 *
 * Read off pi's own login screen rather than guessed: pi exposes no way to
 * enumerate these (no CLI, no RPC, and the provider registry is not a package
 * export), so this list is maintained by hand and WILL drift as pi adds
 * providers. `pi auth check --provider <id>` answers `provider_not_found` for
 * an id pi does not know, which surfaces as "unknown" rather than a crash.
 */
export type LoginProviderId =
  | 'anthropic'
  | 'openai-codex'
  | 'github-copilot'
  | 'kimi-for-coding'
  | 'openrouter'
  | 'radius'
  | 'xai'

/** Where a sign-in has got to. Drives the whole Accounts UI. */
/**
 * Progress of an MCP connector sign-in (`pi mcp login`, run by
 * `apps/desktop/electron/pi/mcp-cli.ts`).
 *
 * Deliberately not `LoginFlowState`: its only interactive step is a browser
 * round-trip that pi itself opens and waits on.
 */
export type ConnectorAuthState =
  | { phase: 'starting' }
  /** pi printed the authorization URL and opened the browser itself. */
  | { phase: 'awaiting-browser'; authorizationUrl: string }
  | { phase: 'connected' }
  | { phase: 'failed'; message: string }

/** One `mcp:authState` push. */
export interface ConnectorAuthPush {
  serverName: string
  state: ConnectorAuthState
}

export type LoginFlowState =
  | { providerId: LoginProviderId; phase: 'starting' }
  /** pi produced a device-code URL; the user finishes in their browser. */
  | {
      providerId: LoginProviderId
      phase: 'awaiting-browser'
      url: string
      /** Device code to type on the provider's page. */
      userCode?: string
    }
  | { providerId: LoginProviderId; phase: 'signed-in' }
  | { providerId: LoginProviderId; phase: 'cancelled' }
  | { providerId: LoginProviderId; phase: 'error'; message: string }

export interface SubscriptionProvider {
  /** pi's provider id — the key in `auth.json` and `pi auth check --provider`. */
  id: LoginProviderId
  name: string
  /** What the user must already be paying for. */
  requires: string
  /**
   * What signing in actually spends. The distinction matters enough to sort
   * the list by: a plan you already pay for is free to use here, while a
   * balance is charged per token even though the sign-in looks identical.
   */
  billing: 'subscription' | 'balance'
  /** Anything the user should know before signing in. Rendered verbatim. */
  caveat?: string
}

/**
 * One provider's readiness, straight from `pi auth check --json`.
 *
 * `status` is pi's own word. `unknown` is Phosphor's: it means the check could
 * not be run at all (pi missing, spawn failed, unparseable output), which is
 * deliberately distinct from pi answering "not_ready".
 */
export interface SubscriptionProviderStatus extends SubscriptionProvider {
  status: 'ready' | 'not_ready' | 'unknown'
  /**
   * Which account the credential belongs to — an email, when the provider's
   * token says so (`libs/session-runtime/src/pi/auth-identity.ts`). Absent for an opaque
   * credential, which is most of them, so the UI must read fine without it.
   * Never the credential itself.
   */
  account?: string
  /** pi's machine-readable reason, e.g. `credentials_not_configured`. */
  reason?: string
  /** Present only when the check itself failed. */
  error?: string
}

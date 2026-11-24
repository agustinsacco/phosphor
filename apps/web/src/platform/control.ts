import type { AccountStatusView, AccountView } from '@phosphor/shared/account'
import {
  CONTROL_ROUTES,
  CONTROL_LIMITS,
  isUuid,
  parseControlError,
  parseMachinesResponse,
  parseGrantIssueResponse,
  parseEnrollmentLookupResponse,
  parseEnrollmentApproveResponse,
  machineRoute,
  type Parsed,
  type MachinesResponse,
} from '@phosphor/shared/control-api'
import type { ControlResult, DesktopControlErrorCode } from '@phosphor/shared/ipc'
import {
  WEB_AUTH_ROUTES,
  WEB_CSRF_HEADER,
  WEB_SIGNIN_ERROR_PARAM,
  type WebSessionResponse,
} from '@phosphor/shared/web-auth'

export interface ControlPorts {
  fetch: typeof fetch
  navigate: (path: string) => void
  changed: (view: AccountView) => void
  /**
   * Drops all owner-scoped memory before publishing the next account: `owner` is the next
   * signed-in Control user's id, or null when the account is signed out or unknown.
   */
  invalidate: (owner: string | null) => void
  /** A failed sign-in's message, shown while signed out until the next sign-in or session. */
  signInError?: string
}
class ControlFailure extends Error {
  constructor(readonly code: DesktopControlErrorCode) {
    super(code)
  }
}
function session(value: unknown): WebSessionResponse {
  if (!value || typeof value !== 'object') throw new ControlFailure('unavailable')
  const v = value as Record<string, unknown>
  const u = v.user as Record<string, unknown> | undefined
  if (
    !u ||
    !isUuid(u.id) ||
    !isUuid(v.clientId) ||
    !(u.login === null || (typeof u.login === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(u.login))) ||
    typeof v.csrfToken !== 'string' ||
    !/^[A-Za-z0-9_-]{32,256}$/.test(v.csrfToken)
  )
    throw new ControlFailure('unavailable')
  return { user: { id: u.id, login: u.login }, clientId: v.clientId, csrfToken: v.csrfToken }
}

/** Transport receives only sanitized refusal codes, never HTTP bodies or credentials. */
function grantFailure(error: unknown): Error {
  return new Error(
    error instanceof ControlFailure && ['not-found', 'gone'].includes(error.code)
      ? 'grant-refused'
      : error instanceof ControlFailure
        ? error.code
        : 'offline',
  )
}

function signInErrorText(code: string): string {
  switch (code) {
    case 'too-many-requests':
      return 'Too many sign-in attempts. Wait a minute and try again.'
    case 'forbidden':
      return 'Sign-in was refused. This account may be disabled.'
    case 'unavailable':
      return 'Can’t reach Phosphor right now. Try again shortly.'
    default:
      return 'Sign-in failed. Try again.'
  }
}
/** Reads a failed sign-in's code from the address once and removes it, keeping the rest. */
export function takeSignInError(page: Pick<Window, 'location' | 'history'>): string | undefined {
  const url = new URL(page.location.href)
  const code = url.searchParams.get(WEB_SIGNIN_ERROR_PARAM)
  if (code === null) return undefined
  url.searchParams.delete(WEB_SIGNIN_ERROR_PARAM)
  page.history.replaceState(page.history.state, '', url.pathname + url.search + url.hash)
  return signInErrorText(code)
}

/** The signed-out screen after an explicit sign-out; unless confirmed, it offers a retry. */
const logoutView = (cleanup: 'complete' | 'pending' | 'unconfirmed'): AccountStatusView =>
  cleanup === 'complete'
    ? { status: 'signed-out' }
    : {
        status: 'signed-out',
        error:
          cleanup === 'pending'
            ? 'Signed out here. Remote cleanup is pending; existing Host grants may remain valid briefly.'
            : 'Disconnected here. Cookie sign-out and remote revocation were not confirmed. Retry sign out.',
        notice: 'sign-out-unconfirmed',
      }

/** Cookie credentials never leave fetch. Only CSRF and short-lived grants enter memory. */
export function createBrowserControl(ports: ControlPorts) {
  let current: WebSessionResponse | null = null
  let signInError = ports.signInError
  const signedOut = (): Extract<AccountStatusView, { status: 'signed-out' }> => ({
    status: 'signed-out',
    ...(signInError ? { error: signInError } : {}),
  })
  let view: AccountView = { account: signedOut() }
  let generation = 0,
    sessionRequest = 0,
    stopped = false,
    // An explicit sign-out owns the session until its cleanup is confirmed: no refresh restores it.
    logoutPending = false
  let logoutCleanup: 'complete' | 'pending' | 'unconfirmed' | undefined
  const requests = new Set<AbortController>()
  const configurationHosts = new Set<string>()
  const publish = () => ports.changed(structuredClone(view))
  function invalidate(owner: string | null = null, account: AccountStatusView = signedOut()) {
    generation++
    current = null
    configurationHosts.clear()
    for (const request of requests) request.abort()
    requests.clear()
    ports.invalidate(owner)
    view = { account }
    publish()
  }
  async function json(
    path: string,
    method = 'GET',
    body?: unknown,
    csrf = current?.csrfToken,
  ): Promise<unknown> {
    if (stopped) throw new ControlFailure('signed-out')
    const epoch = generation
    const bodyText = body === undefined ? undefined : JSON.stringify(body)
    if (bodyText && new TextEncoder().encode(bodyText).length > CONTROL_LIMITS.bodyBytes)
      throw new ControlFailure('bad-request')
    const controller = new AbortController()
    requests.add(controller)
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      const response = await ports.fetch(path, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(method !== 'GET'
            ? {
                'Content-Type': 'application/json',
                ...(csrf ? { [WEB_CSRF_HEADER]: csrf } : {}),
              }
            : {}),
        },
        ...(bodyText === undefined ? {} : { body: bodyText }),
      })
      if (epoch !== generation || stopped) throw new ControlFailure('signed-out')
      // Status before body, so an HTML page counts too. Only 401 ends the session; 403 refuses
      // this request alone (CSRF, client id, a challenge page). A sign-out reads 401 itself.
      if (response.status === 401) {
        if (!logoutPending) invalidate()
        throw new ControlFailure('signed-out')
      }
      if (response.status === 403) throw new ControlFailure('forbidden')
      if (response.status === 204 && method === 'DELETE') return {}
      if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json'))
        throw new ControlFailure('unavailable')
      const reader = response.body?.getReader()
      if (!reader) throw new ControlFailure('unavailable')
      let text = '',
        bytes = 0
      const decoder = new TextDecoder('utf-8', { fatal: true })
      try {
        while (true) {
          const chunk = await reader.read()
          if (chunk.done) break
          bytes += chunk.value.byteLength
          if (bytes > 128 * 1024) {
            await reader.cancel()
            throw new ControlFailure('unavailable')
          }
          text += decoder.decode(chunk.value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        reader.releaseLock()
      }
      if (epoch !== generation || stopped) throw new ControlFailure('signed-out')
      const data: unknown = JSON.parse(text)
      if (!response.ok)
        throw new ControlFailure(parseControlError(data)?.error.code ?? 'unavailable')
      return data
    } catch (error) {
      if (error instanceof ControlFailure) throw error
      if (epoch !== generation || stopped) throw new ControlFailure('signed-out')
      throw new ControlFailure('offline')
    } finally {
      clearTimeout(timer)
      requests.delete(controller)
    }
  }
  async function parsed<T>(
    path: string,
    parse: (v: unknown) => Parsed<T>,
    method = 'GET',
    body?: unknown,
  ): Promise<T> {
    const result = parse(await json(path, method, body))
    if (!result.ok) throw new ControlFailure('unavailable')
    return result.value
  }
  async function result<T extends object>(fn: () => Promise<T>): Promise<ControlResult<T>> {
    if (!current)
      return { ok: false, error: { code: 'signed-out', message: 'Sign in to continue.' } }
    try {
      return { ok: true, ...(await fn()) }
    } catch (e) {
      return {
        ok: false,
        error: {
          code: e instanceof ControlFailure ? e.code : 'offline',
          message: 'Control request unavailable.',
        },
      }
    }
  }
  return {
    view: () => structuredClone(view),
    session: () => current,
    generation: () => generation,
    async refresh() {
      if (logoutPending || stopped) return
      const sequence = ++sessionRequest,
        epoch = generation
      try {
        const next = session(await json(WEB_AUTH_ROUTES.session))
        if (epoch !== generation || sequence !== sessionRequest || logoutPending || stopped) return
        signInError = undefined
        logoutCleanup = undefined
        if (
          !current ||
          current.user.id !== next.user.id ||
          current.clientId !== next.clientId ||
          current.csrfToken !== next.csrfToken
        ) {
          invalidate(next.user.id)
        }
        current = next
        view = {
          account: {
            status: 'signed-in',
            user: { login: next.user.login, name: null, email: null },
            remembered: true,
            storageNote: 'Sign-in uses a secure HttpOnly cookie.',
          },
        }
        publish()
      } catch (error) {
        if (epoch !== generation || sequence !== sessionRequest || stopped) return
        const code = error instanceof ControlFailure ? error.code : 'offline'
        if (code === 'signed-out') return
        // The session check is the one route whose 403 is about the account: it is disabled.
        if (code === 'forbidden')
          return invalidate(null, { status: 'signed-out', error: 'Access refused. Sign in again.' })
        // An outage is no sign-out: keep a known session; without one, say the check retries.
        if (!current) {
          view = { account: { ...signedOut(), notice: 'unreachable' } }
          publish()
        }
        throw error
      }
    },
    signIn() {
      if (stopped) throw new Error('Browser adapter disposed.')
      logoutPending = false
      logoutCleanup = undefined
      signInError = undefined
      invalidate()
      view = { account: { status: 'signing-in' } }
      publish()
      ports.navigate(WEB_AUTH_ROUTES.start)
      return structuredClone(view)
    },
    async signOut() {
      if (logoutCleanup === 'complete' && !current) return structuredClone(view)
      logoutCleanup ??= 'unconfirmed'
      const csrf = current?.csrfToken
      logoutPending = true
      sessionRequest++
      invalidate(null, logoutView(logoutCleanup))
      const epoch = generation
      let outcome = logoutCleanup
      try {
        // If the first request failed, retry may recover the cookie-bound CSRF without restoring UI access.
        const token = csrf ?? session(await json(WEB_AUTH_ROUTES.session)).csrfToken
        const data = await json(WEB_AUTH_ROUTES.signout, 'POST', {}, token)
        if (
          !data ||
          typeof data !== 'object' ||
          !('signedOut' in data) ||
          data.signedOut !== true ||
          !('remoteCleanup' in data) ||
          !['complete', 'pending'].includes(String(data.remoteCleanup))
        )
          throw new ControlFailure('unavailable')
        outcome = data.remoteCleanup as 'complete' | 'pending'
      } catch (error) {
        // A session that is already gone is a finished sign-out.
        if (error instanceof ControlFailure && error.code === 'signed-out') outcome = 'complete'
      }
      if (epoch !== generation || stopped) return structuredClone(view)
      logoutCleanup = outcome
      logoutPending = logoutCleanup !== 'complete'
      view = { account: logoutView(logoutCleanup) }
      publish()
      return structuredClone(view)
    },
    /** Another tab signed out: drop this tab's session; the caller then asks Control again. */
    invalidate: () => {
      sessionRequest++
      invalidate()
    },
    machines: () =>
      result<MachinesResponse>(() => parsed(CONTROL_ROUTES.machines, parseMachinesResponse)),
    lookup: (code: string) =>
      result(() =>
        parsed(CONTROL_ROUTES.enrollmentLookup, parseEnrollmentLookupResponse, 'POST', {
          userCode: code,
        }),
      ),
    approve: (code: string, label: string) =>
      result(() =>
        parsed(CONTROL_ROUTES.enrollmentApprove, parseEnrollmentApproveResponse, 'POST', {
          userCode: code,
          label,
        }),
      ),
    rename: (id: string, label: string) =>
      result(() => {
        if (!isUuid(id)) throw new ControlFailure('bad-request')
        return parsed(machineRoute(id), parseEnrollmentApproveResponse, 'PATCH', { label })
      }),
    remove: (id: string) =>
      result(async () => {
        if (!isUuid(id)) throw new ControlFailure('bad-request')
        await json(machineRoute(id), 'DELETE')
        return {}
      }),
    /** Per-Host configure opt-in, memory only: set by settings access, cleared with the owner. */
    configure(hostId: string, enabled = true) {
      if (!enabled) return void configurationHosts.delete(hostId)
      if (!current || stopped) throw new Error('signed-out')
      configurationHosts.add(hostId)
    },
    async grant(hostId: string) {
      if (!current) throw new Error('signed-out')
      try {
        return await parsed(CONTROL_ROUTES.grants, parseGrantIssueResponse, 'POST', {
          hostId,
          clientId: current.clientId,
          ...(configurationHosts.has(hostId) ? { configure: true } : {}),
        })
      } catch (error) {
        throw grantFailure(error)
      }
    },
    dispose() {
      stopped = true
      sessionRequest++
      invalidate()
    },
  }
}
export type BrowserControl = ReturnType<typeof createBrowserControl>

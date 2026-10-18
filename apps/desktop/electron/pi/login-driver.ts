import type { LoginFlowState, LoginProviderId } from '@shared/models'
import type { AuthCheck } from '@phosphor/session-runtime/pi/provider-auth'
import { ptyManager } from '../pty/pty-manager'
import { checkProviderAuth } from './auth-status'
import { log } from '../debug-log'
import {
  classifyScreen,
  expiredBudget,
  isNewCredential,
  parseAuthPrompt,
  screenTail,
  screenText,
  timeoutMessage,
} from './login-screen'

const STEP_TIMEOUT_MS = 20_000
const POLL_MS = 250
const VERIFY_INTERVAL_MS = 2_000
const CR = String.fromCharCode(13)
const ESC = String.fromCharCode(27)

export interface LoginFlowHandle {
  cancel: () => void
}

interface LoginDriverOptions {
  providerId: LoginProviderId
  label: string
  ptyId: string
  before: AuthCheck
  onState: (state: LoginFlowState) => void
  onFinish: () => void
}

interface LoginAttempt extends LoginDriverOptions {
  cancelled: boolean
  settled: boolean
  sentLogin: boolean
  sentMethod: boolean
  sentProvider: boolean
  answeredHost: boolean
  sentLoginMethod: boolean
  lastAuth: { url: string; userCode?: string } | null
  /** First emission of the current URL starts its browser budget. */
  authAt: number | null
  verifying: boolean
  lastVerifyAt: number
  stepStartedAt: number
  startedAt: number
  timer: ReturnType<typeof setInterval>
}

/** Start polling an already prepared sign-in PTY. */
export function startLoginDriver(options: LoginDriverOptions): LoginFlowHandle {
  const attempt: LoginAttempt = {
    ...options,
    cancelled: false,
    settled: false,
    sentLogin: false,
    sentMethod: false,
    sentProvider: false,
    answeredHost: false,
    sentLoginMethod: false,
    lastAuth: null,
    authAt: null,
    verifying: false,
    lastVerifyAt: 0,
    stepStartedAt: Date.now(),
    startedAt: Date.now(),
    timer: setInterval(() => tick(attempt), POLL_MS),
  }
  return { cancel: () => cancel(attempt) }
}

function emit(attempt: LoginAttempt, state: LoginFlowState): void {
  if (attempt.settled && state.phase !== 'cancelled') return
  if (state.phase === 'signed-in' || state.phase === 'error' || state.phase === 'cancelled') {
    attempt.settled = true
  }
  attempt.onState(state)
}

function finish(attempt: LoginAttempt, state: LoginFlowState): void {
  emit(attempt, state)
  attempt.onFinish()
  clearInterval(attempt.timer)
  ptyManager.kill(attempt.ptyId)
}

function cancel(attempt: LoginAttempt): void {
  if (attempt.cancelled || attempt.settled) return
  attempt.cancelled = true
  // Escape lets pi tear down its pending device-code request before killing.
  try {
    ptyManager.write(attempt.ptyId, ESC)
  } catch {
    /* pty already gone */
  }
  finish(attempt, { providerId: attempt.providerId, phase: 'cancelled' })
}

function tick(attempt: LoginAttempt): void {
  if (attempt.cancelled) return
  // attach is a pure buffer read, not an attachment with side effects.
  const screen = screenText(ptyManager.attach(attempt.ptyId).scrollback)
  const expired = expiredBudget(Date.now(), attempt.startedAt, attempt.authAt)
  if (expired) {
    finish(attempt, {
      providerId: attempt.providerId,
      phase: 'error',
      message: timeoutMessage(expired),
    })
    return
  }
  const step = classifyScreen(screen)
  advanceStep(attempt, screen, step)
  verify(attempt)
  if (!attempt.lastAuth && Date.now() - attempt.stepStartedAt > STEP_TIMEOUT_MS) {
    log('login', 'sign-in stopped at an unknown screen', {
      providerId: attempt.providerId,
      step,
      sent: {
        sentLogin: attempt.sentLogin,
        sentMethod: attempt.sentMethod,
        sentProvider: attempt.sentProvider,
        sentLoginMethod: attempt.sentLoginMethod,
        answeredHost: attempt.answeredHost,
      },
      screen: screenTail(screen),
    })
    finish(attempt, {
      providerId: attempt.providerId,
      phase: 'error',
      message:
        'pi stopped at a screen this sign-in does not know how to answer. ' +
        'Use “Open pi’s login terminal” below to finish it by hand.',
    })
  }
}

function advanceStep(
  attempt: LoginAttempt,
  screen: string,
  step: ReturnType<typeof classifyScreen>,
): void {
  // pi drops keystrokes before painting; send each step only on its own screen.
  if (!attempt.sentLogin) {
    if (/›|>|Describe|pi |MCP:/i.test(screen)) {
      attempt.sentLogin = true
      attempt.stepStartedAt = Date.now()
      ptyManager.write(attempt.ptyId, `/login${CR}`)
    }
  } else if (step === 'auth-method' && !attempt.sentMethod) {
    attempt.sentMethod = true
    attempt.stepStartedAt = Date.now()
    // Subscription auth is the preselected "Sign in with an account".
    ptyManager.write(attempt.ptyId, CR)
  } else if (step === 'provider-list' && !attempt.sentProvider) {
    attempt.sentProvider = true
    attempt.stepStartedAt = Date.now()
    emit(attempt, { providerId: attempt.providerId, phase: 'starting' })
    // Filter by label: pi controls provider ordering.
    ptyManager.write(attempt.ptyId, attempt.label)
    setTimeout(() => {
      if (!attempt.cancelled) ptyManager.write(attempt.ptyId, CR)
    }, 400)
  } else if (step === 'login-method' && !attempt.sentLoginMethod) {
    attempt.sentLoginMethod = true
    attempt.stepStartedAt = Date.now()
    // Browser login is preselected, using the user's real browser session.
    ptyManager.write(attempt.ptyId, CR)
  } else if (step === 'host-question' && !attempt.answeredHost) {
    attempt.answeredHost = true
    attempt.stepStartedAt = Date.now()
    // Blank means github.com; Enterprise hosts need the manual escape hatch.
    ptyManager.write(attempt.ptyId, CR)
  } else if (step === 'awaiting-auth') {
    const auth = parseAuthPrompt(screen)
    const previous = attempt.lastAuth
    // Repaints must neither reopen the browser nor extend its budget.
    if (auth && (!previous || auth.url !== previous.url || auth.userCode !== previous.userCode)) {
      attempt.lastAuth = auth
      attempt.stepStartedAt = Date.now()
      attempt.authAt = Date.now()
      emit(attempt, {
        providerId: attempt.providerId,
        phase: 'awaiting-browser',
        url: auth.url,
        userCode: auth.userCode,
      })
    }
  }
}

function verify(attempt: LoginAttempt): void {
  // Each check spawns pi: serialize and throttle well below the screen poll rate.
  if (
    !attempt.lastAuth ||
    attempt.verifying ||
    Date.now() - attempt.lastVerifyAt < VERIFY_INTERVAL_MS
  )
    return
  attempt.verifying = true
  attempt.lastVerifyAt = Date.now()
  void checkProviderAuth(attempt.providerId)
    .then((result) => {
      // An old ready credential must not close a still-needed callback server.
      if (isNewCredential(attempt.before, result) && !attempt.settled) {
        finish(attempt, { providerId: attempt.providerId, phase: 'signed-in' })
      }
    })
    .catch(() => {
      /* transient; the next tick asks again */
    })
    .finally(() => {
      attempt.verifying = false
    })
}

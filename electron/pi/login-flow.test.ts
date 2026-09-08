import { describe, expect, it } from 'vitest'
import {
  classifyScreen,
  expiredBudget,
  isNewCredential,
  parseAuthPrompt,
  screenText,
  timeoutMessage,
} from './login-flow'

/**
 * The fixtures below are real captures from pi 0.84.1's `/login`, escape
 * sequences and all. They are the contract this module parses: if pi changes
 * how these screens render, these tests are what says so.
 */

const ESC = String.fromCharCode(27)

describe('screenText', () => {
  it('removes CSI cursor moves that would otherwise split a URL', () => {
    const raw = `https://accounts.x.ai/oauth2${ESC}[5C/device?user_code=8G95-72AD`
    expect(screenText(raw)).toBe('https://accounts.x.ai/oauth2/device?user_code=8G95-72AD')
  })

  it('removes OSC title sequences', () => {
    expect(screenText(`${ESC}]0;piready`)).toBe('ready')
  })

  it('treats a carriage return as a line break so redraws stay separate lines', () => {
    expect(screenText('first\rsecond')).toBe('first\nsecond')
  })
})

describe('classifyScreen', () => {
  it('recognises the authentication-method screen', () => {
    const screen = ['Select authentication method:', '→ Sign in with an account'].join('\n')
    expect(classifyScreen(screen)).toBe('auth-method')
  })

  it('recognises the provider list', () => {
    const screen = ['Select provider to configure:', '→ Anthropic • unconfigured'].join('\n')
    expect(classifyScreen(screen)).toBe('provider-list')
  })

  it('prefers the auth prompt when an earlier screen is still in scrollback', () => {
    // The whole reason the checks are ordered: pi does not clear scrollback,
    // so every earlier prompt is still present when the URL appears.
    const screen = [
      'Select authentication method:',
      'Select provider to configure:',
      'Login to xAI',
      'Waiting for authentication...',
    ].join('\n')
    expect(classifyScreen(screen)).toBe('awaiting-auth')
  })

  it('reports unknown for pi’s ordinary prompt', () => {
    expect(classifyScreen('› Describe a task')).toBe('unknown')
  })

  it('recognises Codex’s login-method sub-menu, which sits below the provider list', () => {
    // The provider list is still on screen underneath, so this must be
    // classified before it — otherwise the driver decides it is back at the
    // provider step, refuses to act on it twice, and stalls.
    const screen = [
      'Select provider to configure:',
      '→ OpenAI Codex ✓ stored',
      'Login to OpenAI Codex',
      'Select OpenAI Codex login method:',
      '→ Browser login (default)',
      '  Device code login (headless)',
    ].join('\n')
    expect(classifyScreen(screen)).toBe('login-method')
  })

  it('recognises Copilot’s enterprise-host question', () => {
    // A free-text prompt mid-flow. Blank means github.com; without answering
    // it the driver simply timed out, so the button did nothing for the one
    // provider whose caveat had promised it would ask.
    const screen = [
      'Login to GitHub Copilot',
      'GitHub Enterprise URL/domain (blank for github.com)',
      'e.g., company.ghe.com',
      '(escape/ctrl+c to cancel, enter to submit)',
    ].join('\n')
    expect(classifyScreen(screen)).toBe('host-question')
  })

  it('lets the auth prompt win once the host question has been answered', () => {
    // Both are on screen at once — pi does not clear scrollback — and treating
    // this as still-a-question would stall at the last step.
    const screen = [
      'GitHub Enterprise URL/domain (blank for github.com)',
      'https://github.com/login/device',
      'Enter code: BF6C-292B',
    ].join('\n')
    expect(classifyScreen(screen)).toBe('awaiting-auth')
  })

  it('recognises Radius’s differently-worded login-method menu', () => {
    // Same menu, none of the same words: "Sign in to Radius:" rather than
    // "Select … login method:". Matching the heading missed it entirely.
    const screen = [
      'Login to Radius',
      'Sign in to Radius:',
      '→ Sign in with browser (recommended)',
      '  Sign in with device code (when signing in from another device)',
    ].join('\n')
    expect(classifyScreen(screen)).toBe('login-method')
  })

  /**
   * Every provider words its wait-for-browser screen differently. These are
   * verbatim captures; each one broke an earlier, narrower pattern.
   */
  it.each([
    [
      'Anthropic (loopback, "Complete login")',
      ['Login to Anthropic', 'Cmd+click to open', 'Complete login in your browser.'],
    ],
    [
      'OpenRouter (loopback, "Complete sign-in")',
      ['Login to OpenRouter', 'Cmd+click to open', 'Complete sign-in in your browser.'],
    ],
    [
      'xAI (device code, neither phrase)',
      [
        'Login to xAI',
        'Cmd+click to open',
        'Enter code: 8G95-72AD',
        'Waiting for authentication...',
      ],
    ],
    ['Linux, where the hint says Ctrl', ['Login to xAI', 'Ctrl+click to open']],
  ])('treats %s as awaiting-auth', (_name, lines) => {
    expect(classifyScreen(lines.join('\n'))).toBe('awaiting-auth')
  })
})

describe('parseAuthPrompt', () => {
  const captured = [
    'Login to xAI',
    'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD',
    'Cmd+click to open',
    'Enter code: 8G95-72AD',
    'Waiting for authentication...',
    '(escape/ctrl+c to cancel)',
  ].join('\n')

  it('recovers both the URL and the device code', () => {
    expect(parseAuthPrompt(captured)).toEqual({
      url: 'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD',
      userCode: '8G95-72AD',
    })
  })

  it('returns the URL alone on the frame before the code has painted', () => {
    const partial = [
      'Login to xAI',
      'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD',
    ].join('\n')
    expect(parseAuthPrompt(partial)).toEqual({
      url: 'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD',
    })
  })

  it('does not mistake pi’s own docs links for an auth URL', () => {
    expect(parseAuthPrompt('See https://pi.dev/docs/models for details')).toBeNull()
  })

  it('returns null when no URL is on screen', () => {
    expect(parseAuthPrompt('Select provider to configure:')).toBeNull()
  })

  it('returns a loopback URL whole, with no code', () => {
    // Anthropic's real authorize URL: ~330 characters of redirect_uri, scopes
    // and PKCE challenge. It is why the hidden terminal is 1000 columns wide —
    // at 160 pi wrapped this across three lines and the match stopped at the
    // first break, yielding a URL that looked fine and opened a broken page.
    const url =
      'https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e' +
      '&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback' +
      '&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code' +
      '&code_challenge=0JISiWjnTwiA05nMCGg8vqfWLWjadcyx0siKmvHLFpI&code_challenge_method=S256' +
      '&state=VN2D7kEyjz-WrROHGl5bqnUcYCtLn_yLt6hd3CDiXpQ'
    const screen = ['Login to Anthropic', url, 'Complete login in your browser.'].join('\n')

    const parsed = parseAuthPrompt(screen)
    expect(parsed?.url).toBe(url)
    expect(parsed?.userCode).toBeUndefined()
  })

  it('does not swallow the box-drawing rule the TUI pads lines with', () => {
    // `─` is not whitespace, so a naive \S+ match would append the entire rule
    // to the URL.
    const screen = `https://accounts.x.ai/oauth2/device?user_code=8G95-72AD\n${'─'.repeat(20)}`
    expect(parseAuthPrompt(screen)?.url).toBe(
      'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD',
    )
  })

  it('stops the URL at the trailing box-drawing the TUI pads lines with', () => {
    const boxed = 'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD  \nEnter code: 8G95-72AD'
    expect(parseAuthPrompt(boxed)?.url).toBe(
      'https://accounts.x.ai/oauth2/device?user_code=8G95-72AD',
    )
  })
})

/**
 * The budget split exists because ending a flow kills the pty, and for a
 * loopback provider that pty is the callback server the browser is about to
 * redirect to. A clock that covers setup and the browser together expires
 * mid-sign-in and closes the port under the user.
 */
describe('expiredBudget', () => {
  const MINUTE = 60_000

  it('gives the setup phase a bounded budget', () => {
    expect(expiredBudget(90 * 1000, 0, null)).toBeNull()
    expect(expiredBudget(3 * MINUTE, 0, null)).toBe('setup')
  })

  it('does not spend the setup budget on a human who is in the browser', () => {
    // Ten minutes in, but the URL landed at minute one. Under the single
    // five-minute clock this killed pi's callback server.
    expect(expiredBudget(10 * MINUTE, 0, 1 * MINUTE)).toBeNull()
  })

  it('still bounds the browser trip', () => {
    expect(expiredBudget(20 * MINUTE, 0, 1 * MINUTE)).toBe('browser')
  })

  it('measures the browser budget from the URL, not from launch', () => {
    // A flow that spent a while reaching the URL must not shorten the trip.
    expect(expiredBudget(16 * MINUTE, 0, 2 * MINUTE)).toBeNull()
  })

  it('names the closed callback server, because the browser blames localhost', () => {
    expect(timeoutMessage('browser')).toMatch(/callback server/i)
    expect(timeoutMessage('browser')).toMatch(/localhost/i)
    expect(timeoutMessage('setup')).toMatch(/login terminal/i)
  })
})

/**
 * Switching accounts starts from a provider that is already signed in, so
 * `ready` on its own is not completion — it is the answer the old credential
 * gives a second after pi prints the URL, and acting on it kills the pty that
 * *is* the callback server the browser is about to redirect to.
 */
describe('isNewCredential', () => {
  const ready = (fingerprint?: string): { status: 'ready'; fingerprint?: string } => ({
    status: 'ready',
    ...(fingerprint ? { fingerprint } : {}),
  })

  it('accepts any ready when nothing was signed in before', () => {
    expect(isNewCredential({ status: 'not_ready' }, ready('new'))).toBe(true)
    expect(isNewCredential({ status: 'unknown' }, ready())).toBe(true)
  })

  it('does not accept the credential that was already there', () => {
    // The reported bug: "Sign in again" on a signed-in provider reported
    // success immediately and the browser then hit ERR_CONNECTION_REFUSED.
    expect(isNewCredential(ready('old'), ready('old'))).toBe(false)
  })

  it('accepts a credential that changed, including a second sign-in to the same account', () => {
    expect(isNewCredential(ready('old'), ready('fresh'))).toBe(true)
  })

  it('waits rather than guessing when there is nothing to compare', () => {
    // Better to run out the browser budget than to close the port early.
    expect(isNewCredential(ready('old'), ready())).toBe(false)
    expect(isNewCredential(ready(), ready('new'))).toBe(false)
  })

  it('is never true for a provider that is not ready', () => {
    expect(isNewCredential(ready('old'), { status: 'not_ready' })).toBe(false)
    expect(isNewCredential({ status: 'not_ready' }, { status: 'unknown' })).toBe(false)
  })
})

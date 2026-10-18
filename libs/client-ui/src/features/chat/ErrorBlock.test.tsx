// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'

// jsdom implements neither of these, and importing MessageItem pulls in the
// settings store (matchMedia) and MenuRow's scroll-into-view. Stub before the
// module graph loads, since the store subscribes at module scope.
window.matchMedia = vi.fn().mockReturnValue({
  matches: false,
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
}) as unknown as typeof window.matchMedia
Element.prototype.scrollIntoView = vi.fn()

const { ErrorBlock } = await import('./MessageItem')

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(ui: React.ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
}

beforeEach(() => {
  // ErrorBlock reads the active AWS profile over IPC on mount.
  ;(globalThis as unknown as { window: { phosphor: unknown } }).window.phosphor = {
    invoke: vi.fn().mockResolvedValue({ awsProfile: undefined }),
  }
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

const RETENTION_ERROR =
  "Validation error: The model returned the following errors: data retention mode 'default' is not available for this model See https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html for supported data retention modes."

/** Verbatim from the report: an envelope pi forwarded without unwrapping. */
const EXTRA_USAGE_ERROR =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_011CeDMeGVDtzbJ44qpikt1U"}'

const ON_DEMAND_ERROR =
  "Validation error: Invocation of model ID anthropic.claude-fable-5 with on-demand throughput isn't supported. Retry your request with the ID or ARN of an inference profile that contains this model."

function text(): string {
  return container?.textContent ?? ''
}

function links(): HTMLAnchorElement[] {
  return [...(container?.querySelectorAll('a') ?? [])] as HTMLAnchorElement[]
}

describe('ErrorBlock', () => {
  it('renders the raw provider message', () => {
    render(<ErrorBlock message={RETENTION_ERROR} />)
    expect(text()).toContain("data retention mode 'default' is not available")
  })

  it('explains the retention failure and links the AWS docs', () => {
    render(<ErrorBlock message={RETENTION_ERROR} />)
    expect(text()).toMatch(/account-level Bedrock setting/i)
    const docs = links()
    expect(docs).toHaveLength(1)
    expect(docs[0]?.href).toBe(
      'https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html',
    )
    // Opens in the system browser via main's window-open handler.
    expect(docs[0]?.target).toBe('_blank')
  })

  it('points at the model picker when switching models is the workaround', () => {
    render(<ErrorBlock message={RETENTION_ERROR} />)
    expect(text()).toMatch(/switch models/i)
  })

  it('offers no shell command for the retention failure', () => {
    // There is no command that fixes an account-level Bedrock setting; a
    // runnable-looking one would be a lie.
    render(<ErrorBlock message={RETENTION_ERROR} />)
    expect(container?.querySelector('code')).toBeNull()
  })

  it('tells the on-demand failure to pick a region-prefixed variant', () => {
    render(<ErrorBlock message={ON_DEMAND_ERROR} />)
    expect(text()).toMatch(/inference profile/i)
    expect(text()).toMatch(/US, EU, or Global/)
    expect(container?.querySelector('code')).toBeNull()
  })

  it('still renders a runnable command for shell-fixable errors', () => {
    render(
      <ErrorBlock message="Token is expired. Run aws sso login to refresh this SSO session." />,
    )
    expect(container?.querySelector('code')?.textContent).toMatch(/aws sso login/)
  })

  it('renders an unrecognized error as plain text with no remedy', () => {
    render(<ErrorBlock message="overloaded_error: upstream capacity" />)
    expect(text()).toContain('overloaded_error')
    expect(container?.querySelector('code')).toBeNull()
    expect(links()).toHaveLength(0)
  })

  it('falls back to a generic message when none is given', () => {
    render(<ErrorBlock />)
    expect(text()).toContain('The model request failed.')
  })

  describe('provider JSON envelopes', () => {
    it('shows the sentence, not the JSON, and hides the payload behind a toggle', () => {
      render(<ErrorBlock message={EXTRA_USAGE_ERROR} />)
      expect(text()).toContain('Third-party apps now draw from your extra usage')
      // The envelope itself must not be in the visible text…
      expect(text()).not.toContain('"invalid_request_error"')
      // …but its identifying facts stay on the toggle, for support tickets.
      expect(text()).toContain('req_011CeDMeGVDtzbJ44qpikt1U')
      expect(text()).toContain('HTTP 400')
      expect(container?.querySelector('pre')).toBeNull()
    })

    it('reveals the raw payload when the toggle is clicked', () => {
      render(<ErrorBlock message={EXTRA_USAGE_ERROR} />)
      const toggle = container?.querySelector('button[aria-expanded]') as HTMLButtonElement
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      act(() => toggle.click())
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(container?.querySelector('pre')?.textContent).toBe(EXTRA_USAGE_ERROR)
    })

    it('offers the usage page and a model switch for the extra-usage failure', () => {
      render(<ErrorBlock message={EXTRA_USAGE_ERROR} />)
      expect(text()).toMatch(/plan limit is used up/i)
      expect(links().map((a) => a.href)).toContain('https://claude.ai/settings/usage')
      expect(text()).toMatch(/switch models/i)
      // Nothing in a shell fixes a billing limit.
      expect(container?.querySelector('code')).toBeNull()
    })

    it('adds no toggle when there was no envelope to unwrap', () => {
      render(<ErrorBlock message={RETENTION_ERROR} />)
      expect(container?.querySelector('button[aria-expanded]')).toBeNull()
    })
  })
})

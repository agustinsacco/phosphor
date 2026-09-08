# Signing into a provider is a button now

Date: 2026-08-26

## What changed

The Accounts tab used to hand the user a terminal. It spawned `pi --no-session`
in a visible PTY, typed `/login` after a 1200 ms guess, and left them to drive
pi's TUI: pick an auth method, find the provider, read a URL off a terminal,
cmd-click it, and notice on their own when it worked.

Now each provider is a row with a **Sign in** button. Pressing it drives that
same TUI off-screen, opens the authorization page in the user's real browser,
shows the device code when there is one, and flips the row to **Signed in** on
its own. The terminal is still there as an escape hatch, but it is no longer
the path.

The provider list also went from 3 hand-picked entries to all 7 pi offers,
split into "use a plan you already pay for" and "billed per token" — because
signing into xAI and signing into Claude Pro look identical in the UI and cost
completely different things.

## Why it is a PTY at all

pi exposes sign-in nowhere else. There is no `pi auth login`, the RPC protocol
has no auth command, and `@earendil-works/pi-ai` stopped exporting its OAuth
registry (in 0.84 the `./oauth` subpath is types-only). Deep-importing the
private path would break on any pi upgrade.

So the pty stays. What changed is who has to look at it.

## The interesting part: there is no such thing as "the login screen"

`electron/pi/login-flow.ts` is a parser for someone else's rendering, and the
assumption it started with — that providers share one flow — was wrong four
separate times. Each was found by driving the real TUI, not by reading code:

| Provider       | What it does that nothing else does                                      |
| -------------- | ------------------------------------------------------------------------ |
| xAI            | device code: `Enter code: 8G95-72AD` + `Waiting for authentication...`   |
| Anthropic      | loopback redirect, no code at all; pi runs a `localhost` callback server |
| OpenAI Codex   | an extra sub-menu: browser login vs device code                          |
| Radius         | the same sub-menu, worded nothing like Codex's                           |
| GitHub Copilot | a free-text question: GitHub Enterprise host, blank for github.com       |
| OpenRouter     | says "Complete **sign-in**" where Anthropic says "Complete **login**"    |

Every one of those stalled the driver until it was handled. The lesson that
shaped the final code: **classify on the affordance, not the prose.** Provider
prose varies per provider; `Cmd+click to open` is pi's own "here is a URL" hint
and appears in all of them. Same for the sub-menu, which is matched on its
preselected `Sign in with browser` / `Browser login` option rather than its
per-provider heading.

### The bug that would have shipped quietly

The hidden terminal is **1000 columns wide**, which looks absurd until you know
why. pi hard-wraps output to the reported width. Anthropic's authorize URL is
~330 characters (redirect_uri, scopes, PKCE challenge), and at the original 160
columns pi split it across three lines. The URL regex then matched only up to
the first break and returned a URL that _looked_ well-formed and opened a
broken page. There is no reliable way to rejoin the continuation lines, because
the break lands mid-token with no marker. Being wider than any URL is the fix.

## How completion is detected

By asking pi, via `checkProviderAuth` (`pi auth check --provider … --json`),
throttled to every 2s once a URL is on screen. The TUI does announce success,
but in prose that can be reworded any release; `auth check` is the same fact
the rest of Phosphor already trusts.

## What is deliberately not automated

- **A GitHub Enterprise host.** It cannot be guessed, so Copilot's button signs
  into github.com and the row's caveat points enterprise users at the terminal.
- **Anything else pi asks that this driver does not recognise.** The step
  timeout fires after 20s with an error naming the login terminal, rather than
  guessing at a prompt and pressing Enter on it.

## Verification

Seven providers driven end-to-end against real pi (0.84.1), each reaching the
device-code or browser-redirect screen and then escaping without completing a
login: xAI, Anthropic, GitHub Copilot, OpenAI Codex, OpenRouter, Kimi For
Coding, Radius. The probe imports the shipping parsers rather than
reimplementing them, so a green run is about this code and not about the probe.

21 unit tests in `electron/pi/login-flow.test.ts` pin the screen
shapes as verbatim captures. Each wording variant in the table above has a test
whose failure names the provider that broke it.

The tab itself was exercised in the browser harness (`npm run dev:web`), which
now mocks the whole flow: starting, device code, cancel, and the row flipping.

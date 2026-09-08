# 2026-08-29 — the dangerous-command dialog says what is dangerous

A permission-gate extension asked to run a command. The dialog that appeared
was a wall of shell script in bold sans-serif, taller than the screen, with no
scrollbar and no indication of what it objected to. The only readable words
were the last two: `Allow?`.

## Why it looked like that

A gate is an extension hooking `tool_call`. When it decides a `bash` command
is dangerous it calls `ctx.ui.select`, and the entire prompt is one string:

```ts
const choice = await ctx.ui.select(`Dangerous command:\n\n  ${command}\n\nAllow?`, ['Yes', 'No'])
```

Phosphor has no protocol for approvals. That arrives as an ordinary
`extension_ui_request`, and `DialogSheet` put the whole string — heading,
command, question — into `ModalPanel`'s **title**: `text-lg font-semibold`, in
a 480px panel with no height cap. A one-line `rm -rf /tmp/x` was fine. A
heredoc writing a 40-line script rendered as several thousand words of
unwrapped prose running off the top and bottom of the window.

Worse than the layout: **nothing in the dialog said which part was dangerous.**
The gate's verdict is a boolean, so the user had to re-derive the regex match
by eye, in a font with no monospace alignment, in a body they could not scroll.

## What replaced it

`src/features/extension-ui/commandApproval.ts` (pure) plus
`CommandApprovalSheet.tsx` (the surface). `ExtensionDialogHost` tries the
parse first and falls through to the generic sheet on a miss.

- **`parseCommandApproval`** recognises heading / command / trailing yes-no
  question, and for a `select` also requires options that clearly mean yes and
  no. It refuses rather than guesses: an unrecognised dialog renders as before.
- **`analyzeCommand`** re-derives the risk from the pattern classes gates match
  on, and returns each one as a named, explained, character-ranged match. The
  UI renders `risks.length === 0` honestly ("Phosphor could not identify which
  part it objected to") instead of inventing a reason.

**The `context` field is the real finding.** The command that triggered this
was writing a script to `/tmp` with a heredoc. The `rm -rf` the gate matched
was inside the heredoc body — text being written to a file, never run. So a
match now carries where it landed:

| context   | meaning                            | rendering                      |
| --------- | ---------------------------------- | ------------------------------ |
| `command` | runs                               | red highlight, row tinted      |
| `heredoc` | written to a file here             | dotted underline, plain colour |
| `quoted`  | an argument or message, not a call | dotted underline, plain colour |

When every match is incidental the sheet says so at the top. That turns the
common false positive from "squint at 40 lines" into one sentence.

## Rules worth keeping

- **Answer in the gate's own words.** A `select` echoes back the exact option
  string the gate offered. Inventing `'Yes'` would break a gate that offered
  `Allow once`.
- **Deny is the safe answer.** It holds focus, Escape denies, the backdrop does
  not dismiss, and nothing approves on a keypress.
- **Phosphor re-derives, it does not read.** The gate never tells us why. Phosphor
  can therefore name a risk the gate did not fire on, or miss the one it did.
  Both states are rendered as what they are.

## Also fixed

The generic dialog is no longer unbounded: an extension title caps at `max-h-40`
and scrolls, a `confirm` message caps at `45vh`, and `select` options wrap.
Any extension can send arbitrary text there; pi's TUI wraps it, so gates do.

`src/dev/mockPhosphor.ts` raises a real approval in the browser harness when a
prompt starts with `danger` — the harness has no pi, so it had no way to show
the one dialog whose whole purpose is how it handles an ugly command.

## Files

- `src/features/extension-ui/commandApproval.ts` + `.test.ts`
- `src/features/extension-ui/CommandApprovalSheet.tsx` + `.test.tsx`
- `src/features/extension-ui/ExtensionUiHosts.tsx` (host wiring, title caps)
- `src/dev/mockPhosphor.ts`, `src/components/icons.tsx` (`WarningIcon`)
- `specs/reference/extensions.md` § Command approval dialogs

# The home composer gets the `/` menu

**2026-09-08**

Typing `/` on a workspace's home screen did nothing. The same keystroke in a
session opens a menu of every skill, prompt and extension command pi resolved.
Starting a new lane therefore meant starting it blind: you had to remember a
skill's exact name, or send a throwaway first prompt just to earn the menu.

## Why it was missing

Not the textarea. `ComposerField` is already shared by both composers, and it
deliberately owns no popups — its docstring says the `/` and `@` menus stay
with the caller. The chat composer implemented them; the home composer never
did.

Behind that was a real obstacle. The chat composer's list is session state:
`bootstrapSession` asks the session's own pi `get_commands` at spawn and puts
the answer on the chat store. The home screen has no session and no pi process,
so there was nothing to ask.

## What changed

**A workspace-scoped probe.** `electron/pi/commands.ts` asks a throwaway
`pi --mode rpc --no-session` for `get_commands` — the same spawn the skills page
and the model catalogue already use, no tokens spent. The skills page's own
private copy of that probe is now a caller of it rather than a second
implementation. Exposed as `pi:commands`, cached per workspace for a minute
(short on purpose: a skill is a file the user just wrote, and "I added it and
Phosphor still can't see it" is the failure that matters). Empty when pi cannot
be run, which degrades to exactly the old behaviour — no menu.

Bundled Phosphor extensions register no commands, so `--no-session` resolves
the same list a real session gets.

**One `/` menu implementation.** `useSlashMenu` now owns when the menu is open,
what it matches, the keymap and what picking does; `Composer` and
`WorkspaceHome` both drive it. The home screen offers no native commands —
`/compact`, `/export` and `/name` all act on a session that does not exist yet.

Picking prefills `/name ` in both places, and the send path needed nothing:
slash commands have always gone to pi as ordinary prompt text, so a command
typed as a lane's first message already worked.

## Fallout worth knowing

`Composer` used to share one `activeIndex` between the `/` menu and the `@`
menu, and `updateOverlays` could open both at once (`/foo@bar` satisfies both
patterns). Key handling picked the command menu; rendering showed both popups.
The `/` menu now suppresses the mention menu outright, so the two agree.

The home composer still has no `@` file mentions. Nothing blocks it now — the
menu component and the file index are both there — it just was not part of this
change.

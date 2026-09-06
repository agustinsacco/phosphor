# Several Claude accounts, side by side — 2026-09-04

Settings → Claude Code used to offer **Switch account**, and it meant what it
said: `claude auth logout` then `claude auth login`, because the CLI keeps one
credential and there was believed to be no way to hold two. That belief was
wrong, and it cost real work — a session hitting a 5-hour limit meant signing
out of one plan and back into another, which also signed out the terminal.

pidex now keeps as many Claude logins as you want, in an order you control, and
picks one per session.

## The mechanism

The CLI derives its keychain service name from a config directory. From the
2.1.260 bundle:

```js
var t5 = '-credentials'
function fx(n = '') {
  let e = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
    t = e !== undefined ? !e : !process.env.CLAUDE_CONFIG_DIR,
    r = e !== undefined ? e.normalize('NFC') : configDir(),
    c = t ? '' : `-${sha256(r).slice(0, 8)}`
  return `Claude Code${SUFFIX}${n}${c}`
}
```

So `CLAUDE_SECURESTORAGE_CONFIG_DIR=<dir>` moves the entry to
`Claude Code-credentials-<hash of dir>`. Measured:

```
$ claude auth status
{ "loggedIn": true,  "email": "…", "projectsDirectory": "/Users/…/.claude/projects" }
$ CLAUDE_SECURESTORAGE_CONFIG_DIR=~/scratch claude auth status
{ "loggedIn": false, "authMethod": "none", "projectsDirectory": "/Users/…/.claude/projects" }
```

Only the credential moves. `CLAUDE_CONFIG_DIR` is the wrong knob for this and
was rejected: it relocates `projects/`, `settings.json`, skills and plugins with
it (`projectsDirectory` follows it, confirmed the same way).

## Why pi-claude-cli did not change

`spawnClaude` builds its child env as `{ ...process.env }`. pidex spawns one
`pi` per session, and pi-claude-cli >= 0.7.0 keeps **one** CLI process per pi
session. Putting the variable on the pi spawn therefore binds pi, the extension
and the parked CLI process to a single account for the session's whole life.
The whole feature is pidex-side; nothing was published to the provider package.

## Shape

- `shared/models.ts` — `ClaudeAccount`, `ClaudeAccountPrefs`, `ClaudeRoutingMode`.
- `electron/claude/routing.ts` — pure: `claudeAccountEnv`, `selectAccount`,
  `cooldownFromUsage`. This is the file to read; `routing.test.ts` pins the rules.
- `electron/claude/accounts.ts` — the store, the per-account credential dirs
  under `userData/claude-accounts/<id>`, sign-in/out, usage refresh.
- `electron/pi/session-accounts.ts` — parks a spawn's pick until the session's
  `.jsonl` path exists, and keeps it for the session's life so the UI can say
  which account a lane spends ([2026-09-06](2026-09-06-claude-account-routing.md)).
- Settings → Claude Code → **Accounts** — list, reorder, add, remove, and the
  routing picker.

Account one is seeded with `credentialDir: null`, i.e. the CLI's own default
entry. Nothing migrates and your terminal `claude` keeps sharing it.

## Three things this deliberately does not do

**No mid-session failover.** The account is fixed when a session starts. The CLI
process is parked for the session's life and its credential came from the
environment it was spawned with, so "ordered, top to bottom" means _start_ on
the highest account with quota left. A session that hits its limit is a session
you restart.

**Cooldowns are cached, not live.** "Out of quota" comes from a
`claude -p /usage` reading per account (zero quota, ~2s). Fetching that inline
would add seconds to every session start, so routing reads main's cache and
kicks off a refresh in the background — the _next_ session start is the one that
benefits. **Refresh usage** in the tab forces it. When every account looks
exhausted the rule still returns one rather than refusing to spawn: on cached
data, "all out" is as likely to be stale as true.

**Only the 5-hour window creates a cooldown.** A full weekly window is a real
block too, but its reset is days out, and silently skipping an account for days
on one cached reading is not a call to make without saying so.

## The one shared piece of state

`~/.claude.json`'s `oauthAccount` block follows `CLAUDE_CONFIG_DIR`, not the
securestorage dir, so every account shares it and the last one to sign in or
refresh wins its org id. That block feeds the CLI's org header fallback. Each
account therefore records its `orgId` at sign-in and gets it back as
`CLAUDE_CODE_ORGANIZATION_UUID`, which the CLI reads _before_ `oauthAccount` —
so a session's org always matches its token. The rest of that block is display
and telemetry.

## Resumes keep their account

`ClaudeAccountPrefs.bindings` maps session file path → account id, and a bound
session ignores the routing rule. Without it, resuming a round-robin session
could land on a different plan: a total prompt-cache miss, and a thread whose
cost is split across two subscriptions. The binding is written by the renderer
(`claude:bindSession`) because main chooses the account at spawn, before pi has
written the file that identifies it — `bootstrapSession`'s `get_state` is the
first moment the path exists.

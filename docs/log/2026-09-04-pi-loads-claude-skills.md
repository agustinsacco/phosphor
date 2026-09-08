# pi now loads the workspace's Claude Code skills

**2026-09-04.** The repo's `.claude/skills/` (debug, e2e, run) were visible
only to Claude Code's own skill loader. pi sessions — which is to say every
Phosphor session — never saw them, so the `/` command menu offered `skill:debug`
to a bare `claude` run but not to the app that exists to wrap pi.

pi has first-class support for this (its `skills.md`, "Using Skills from
Other Harnesses"): a `skills` array in settings pointing at another
harness's skill directory. This change checks in `.pi/settings.json` with

```json
{ "skills": ["../.claude/skills"] }
```

The path is relative to the settings file's directory, so it resolves to the
workspace's `.claude/skills` in the main checkout and in every worktree
(each worktree carries its own checked-in copy).

Two properties worth naming:

- **Claude-provider sessions get them for free.** pi composes discovered
  skills into its system prompt, and `pi-claude-cli` ≥ 0.4.16 passes that
  prompt to the CLI verbatim. No copy, no symlink, no provider change. The
  known cost is a double listing on Claude sessions: the CLI also discovers
  `.claude/skills` natively, so those three skills appear both as native
  Claude skills and in pi's prompt block. Descriptions only — a few hundred
  tokens — and both routes load the same `SKILL.md`.
- **Project settings ride pi's trust prompt.** A `.pi/settings.json` in the
  repo means pi asks for project trust on first session in an untrusted
  checkout (recorded in `~/.pi/agent/trust.json`, walking up parents — so
  trusting the repo root covers all worktrees). Same flow project-scope
  packages already use.

Verified with a zero-inference RPC probe from this worktree:
`get_commands` over `pi --mode rpc --no-session` lists all three as
`skill:debug` / `skill:e2e` / `skill:run` once the project is trusted, and
skipped them (silently, by design) before trust was recorded.

The machine-local counterpart — personal skills in `~/.claude/skills` — is a
user settings entry, not a repo one: `"skills": ["~/.claude/skills"]` in
`~/.pi/agent/settings.json`.

# Removing orchestration

2026-09-03

The three-layer orchestration feature is gone: the fleet hub, the per-project
orchestrator session, its rules/modes/autopilot, the home screen's mission
control, and the idle-session reaper that sat on top of the hub.

## Why

Maintenance cost exceeded value. The design doc had 14 verified drift items
against the code it described
(`specs/backlog/spec-drift-2026-08-30.md`, deleted 2026-09-09 at zero open findings),
and the layer touched session spawn, IPC, the sidebar, the home screen and the
settings modal — so every unrelated change had to reason about it.

Every session is independent again. `electron/registry.ts` is the only thing
that knows what is running, and sessions are created from the renderer only.

## What went with it

Two capabilities were removed that were not orchestration, because both were
built on the hub's derived state and cannot stand without it:

- **Automatic reclamation of idle sessions.** `SessionReaper` read the hub's
  `phase` / `lastActivityAt` / `pendingQuestion` to decide what was safe to
  suspend. Each live `pi --mode rpc` costs ~200 MB, so ten open lanes is again
  ~2 GB held until quit. The manual escape hatch survives: **suspend** on a
  sidebar row still reclaims one subprocess and keeps the row. Rebuilding the
  automatic policy needs a hub-free activity tracker; see
  [2026-09-01-session-reaper-and-live-stats.md](2026-09-01-session-reaper-and-live-stats.md)
  for the policy that was there.
- **Desktop notifications.** `startNotifier` was the only producer, driven by
  the hub's "this session is blocked on you" projection. No `Notification` is
  raised anywhere now.

Their whole control surface went too, rather than being left to lie to the
user: the Advanced tab's "Session memory" section, `app:setSessionReaperPrefs`,
`app:setNotificationsMuted`, `pi:setActiveSession`, the `reaped` session push,
and `SessionReaperPrefs` / `notificationsMuted` in `AppPrefs`.

## Notes for existing installs

- Prefs written under `orchestrator`, `orchestratorSessions`,
  `orchestratorDigests`, `sessionReaper` and `notificationsMuted` are simply
  ignored. Nothing prunes them; they are inert JSON.
- Orchestrator session files already on disk are now ordinary sessions. The
  scanner no longer filters them, so they appear as sidebar rows and count in
  the home screen's stats and heatmap. Their transcripts replay tool calls
  (`fleet_status`, `send_message`, …) that no longer exist.

## What stayed

`electron/broadcast.ts` — the send-to-every-window helper used to live in
`electron/orchestrator/`, and the MCP auth flow still needs it.

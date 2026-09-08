# Live README screenshots: a second capture runner against a real pi

The README's gallery is now shot against a **real pi instance** —
`scripts/capture-live-shots.mjs`, `npm run shots:live` — instead of the e2e
stub. The stub runner (`npm run shots`) stays for deterministic verification;
the live one is what regenerates the README. App prefs are isolated
(`PHOSPHOR_TEST_USER_DATA`), pi's side deliberately is not: real providers, real
model catalogue, real sessions in the sidebar, two genuinely metered turns
(one edit task in a disposable worktree, one artifact task).

Composer testids added for driveability: `model-chip` and `thinking-chip` in
`src/features/chat/composer/ModelPicker.tsx` (the home picker already had
`home-model-picker`).

Three things the shoot taught us, worth keeping:

- **A screenshot agent is still an agent.** The first phrasing of the edit
  task left the model free to act on what it found: it pushed its worktree
  branch and opened a real PR on the repo (closed as #165). The task now ends
  with "do not run git or gh, do not commit, do not push, do not open a PR",
  and the script comment marks that sentence load-bearing.
- **`getByLabel('Stop')` must be exact.** A sidebar PR badge's accessible name
  contained the word "stop" ("… stop telling signed-in servers to sign in —
  merged"), and substring matching waited on the badge instead of the
  composer's Stop control for the full turn timeout.
- **The Changes pane is empty for CLI-side providers.** `collectTouchedFiles`
  collects pi-native tool calls; on `pi-claude-cli` the CLI executes its own
  Edit/Write tools and Phosphor sees only `[Claude Code · …]` markers, so a
  session's edits never reach the pane. The live runner works around it by
  running the edit session on a pi-native provider (`openai-codex`). An
  actual fix would parse the id-tagged result markers
  (`PI_CLAUDE_CLI_TOOL_RESULTS=1`) into touched files — left open.

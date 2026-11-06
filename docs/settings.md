# 09 — Settings

One component, `SettingsSurface` (`libs/client-ui/src/features/settings/`), holds the
search field, the section navigation and the open section in every shell. Desktop
frames it in a **modal** (`SettingsModal.tsx`, dialog "Settings", `ModalOverlay`), so it
inherits the theme, the UI scale and the app's lifecycle. Cmd/Ctrl+, opens it;
Cmd/Ctrl+/ opens it on Keybindings. The browser frames the same surface in its
Settings page (`shell/compact/CompactSettings.tsx`, `PageShell`/`PageBody`). The frames
add only their chrome: a title and a close button in the dialog, the page heading in
the browser.

## Sections and capabilities

`settingsIndex.ts` declares every section with a **scope** (`device`: this client;
`machine`: the machine chosen in **Configure**) and the `Platform` capabilities it
needs. The surface lists only sections the platform supports, and search
(`SETTINGS_INDEX`) honours the same filter, down to single rows. Nothing branches on
the form factor.

| Section          | Scope             | Needs               | Desktop | Browser | What it is                                                                                               | Writes                                                                |
| ---------------- | ----------------- | ------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Appearance       | device            | (rows below)        | yes     | yes     | Theme, UI scale, per-surface font sizes, mono font                                                       | Phosphor prefs (electron-store; browser storage)                      |
| Writing          | device            | `writingAssist`     | yes     | no      | Spellcheck switch, autocomplete, learned prompts                                                         | Phosphor prefs; `<userData>/writing/prompts.jsonl`                    |
| Lanes            | device            | none                | yes     | yes     | Lane markers, PR status, branch prefix and slug length; the worktree switch needs `localLanes`           | Phosphor prefs (browser storage in the browser)                       |
| Voice            | device            | `localVoice`        | yes     | no      | Dictation on/off and which local speech model                                                            | Phosphor prefs; model files in `<userData>/voice/`                    |
| Keybindings      | device            | `appShortcuts`      | yes     | no      | Static reference sheet                                                                                   | nothing                                                               |
| Phosphor account | device            | none                | yes     | yes     | The signed-in GitHub account and Sign out (or Sign in)                                                   | `account:*`                                                           |
| App installation | device            | `installableApp`    | no      | yes     | Install Phosphor, and the in-app attention note                                                          | nothing                                                               |
| About            | device            | rows need `appInfo` | yes     | yes     | Versions, update check, pi drift warning, font licenses                                                  | nothing                                                               |
| Agent            | machine, both     | a machine           | yes     | yes     | pi's agent defaults, per machine or folder                                                               | `~/.pi/agent/settings.json` or `<ws>/.pi/settings.json`; a Host's own |
| Accounts         | machine, both     | a machine           | yes     | yes     | Subscription logins pi can drive, and a link to Claude Code                                              | pi's provider auth; a Host signs in in a private terminal             |
| Extensions       | machine, both     | a machine           | yes     | yes     | pi package management, one view on every machine ([below](#extensions))                                  | shells out to `pi install` / `remove` / `update`                      |
| ↳ Claude Code    | machine, both     | a machine           | yes     | yes     | The `pi-claude-cli` provider on every machine: health and Install, accounts, routing                     | Phosphor prefs + the package's own config                             |
| ↳ Web access     | machine, both     | package             | yes     | yes     | The `pi-web-access` provider: search, fetch, PDF                                                         | `web-search.json`                                                     |
| ↳ Computer use   | machine, both     | package             | yes     | yes     | Info page for `@injaneity/pi-computer-use`                                                               | nothing (read-only)                                                   |
| ↳ Subagents      | machine, both     | installed package   | yes     | yes     | Delegation guide, profile precedence, configuration ownership                                            | This Mac: global Pi settings in the raw editor                        |
| MCP Connectors   | machine, both     | a machine           | yes     | yes     | pi's built-in MCP: curated OAuth catalog + custom servers, per machine or folder                         | `~/.pi/agent/mcp.json` or `<ws>/.pi/mcp.json`; a Host's own           |
| Folders          | machine, both     | per machine         | yes     | yes     | This Mac: recent folders and sandboxes; a Host: registered folders and trust                             | recents (This Mac); the Host, through `hosts:*Repository`             |
| Optimization     | machine, This Mac | `localLanes`        | yes     | no      | Headroom tool-result compression + the Advisor                                                           | Phosphor prefs; `headroom:*` lifecycle in main                        |
| Advanced         | machine, both     | per machine         | yes     | yes     | Version and update, pi health, PATH, agent dir; This Mac: raw editors, maintenance, resources; Host: env | the pi files it edits; maintenance prefs                              |

A machine section is listed for This Mac when the client has `localLanes`, and for a
Host when it has `machineSettings`; there a Host writes its own files through
`hosts:settings*` ([below](#host-machine-settings)).

Appearance rows: UI scale needs `pageZoom` (native page zoom) and Terminal font size
needs `terminal`. Without `savedFontPrefs` the section says that font changes last
until reload; only the theme is stored on the device. About's version, update, pi and
runtime rows need `appInfo`; without it About shows the lockup and font licenses.
Send feedback sits in the navigation's footer when the platform has `feedback`
([feedback.md](feedback.md)).

MCP Connectors is top level and always present on This Mac, since MCP is built into
pi rather than added by a package. The items nested under Extensions follow the
chosen machine (`useExtensionTabs`): an item is listed when the section registry has
a view for that kind of machine and it is listed everywhere (`always`: Claude Code,
whose page offers Install) or its package is there. On every machine a declared
package counts, so its health and setup screens stay reachable during setup and
repair; Subagents needs it installed. Every machine reads the packages of the scope
line's folder, as its Extensions page does, and lists only a read of that scope
(`extensionPackageLists.ts`, one list per machine and folder). This Mac's list is
read once per scope and on Refresh; a Host's once per connection and scope while
configuration access is granted. On every machine it is read again whenever its
Extensions page reads, as after an install or removal ends. So a fresh install gets
its item without a tab change, and an item whose package vanished falls back to
Extensions.

Phosphor's prefs live in electron-store. pi's config stays in pi's files. The
two are never mixed.

Below the `md` breakpoint the navigation becomes a top bar: the search field, then
the sections and the Configure selector as one horizontally scrolling strip. On wider
layouts the navigation is a column beside the open section, with Send feedback pinned
to its bottom.

## Machine scope

Device sections come first, then **Configure** (a selector of machines) and the
chosen machine's sections. Configure lists **This Mac** (the local machine's
platform label, This PC or This computer off macOS) when the client has local
lanes (`localLanes`) and every known Host (the machines directory and the connected
Hosts) when it can configure one (`machineSettings`).

The default is the Settings Host (`useSettingsHost`): an open Machines detail, else
the active Host lane, else a Host chosen in the machine switcher. Choosing This Mac in
the switcher wins over an active Host lane. Without a Settings Host the default is
This Mac when present, else the browser page's machine, else the first Host. The
choice lives in `settingsUiStore.machine` and resets each time the dialog opens or the
browser page is entered.

Machine sections are one list (`TABS` in `settingsIndex.ts`). A concern both kinds of
machine have is one section with one id, label and place: Agent, Accounts, Extensions,
MCP Connectors, Folders and Advanced. Each section says whether This Mac has it and which Host
settings section renders it on a Host; a machine lists only its own (Optimization is
This Mac's). Lanes and Voice are device sections: how this client shows lanes and names
their branches, and its dictation, whichever machine runs the lane. So switching machines
keeps the open concern, an extension item the other machine does not list opens its
Extensions, and anything else opens the machine's first section. Search lists a
section's rows only on the machine that renders them.

Every machine section opens under one **scope line** (`SettingsScopeLine`):
**Configuring \<machine\>**, then the section's scope controls. It is the only place
a section names its machine. Agent, Extensions and MCP Connectors are **scoped**: the
line offers **Machine** or **Folder** (a radio group, "Configuration scope") and, for a
folder, which one ("Configuration folder"). On This Mac a folder is the settings
workspace or a recent workspace; on a Host it is one of that Host's registered
folders. Choosing **Folder** picks the active lane's folder when it is listed (on a
Host, the folder of an active lane running there), else the first. The choice
is `settingsUiStore.folder` (null is the whole machine); it resets when the dialog
opens, when the browser page is entered and when another machine is chosen. Views
read it and never render a scope switch of their own. The line ends with one
**Refresh** on every machine (`ScopeRefresh`), which reads the open section again: on
This Mac each section's own read (`useLocalRead`, or `useOnLocalRefresh` where a
loader makes the first read; Subagents and Computer use
read nothing there, so it changes nothing), on a Host its settings read once
configuration access is granted, or for Folders the link's folders.

This Mac's sections mount only while This Mac is chosen, so choosing it always shows
its controls, even while a Host lane is the active lane; they then use This Mac's home
workspace, never the Host lane's folder. While a Host is chosen none of This Mac's
controls mount and This Mac's packages are not read. A Host's sections render behind
the Host gate ([below](#host-machine-settings)). A section change, a machine change, a
scope change, Refresh, closing the dialog and leaving the browser's Settings page all
wait for a Host save in flight and ask before dropping a refused draft.

A browser that knows no machine it can configure lists only device sections, with a
**No machine to configure** notice and **Open Machines** below the navigation.

Every link into Settings goes through `useOpenSettings()(machine, tab)`
(`openSettings(navigate, machine, tab)` outside React): Desktop opens the dialog on
that section and machine, the browser navigates to `/pages/settings/<machine>`. The
Machines page, a machine's provider and update links, Skills sharing, the composer's
context links, onboarding and the MCP migration notice all use it.

A remote lane's context meter uses the Host-reported effective window, preferring
the live context extension value over the stats poll. It labels the budget with
the machine name. This Mac's Context budget preference never caps that meter.

## Host machine settings

A Host's machine settings open from Settings (**Configure → \<Host\>**) and from
**Machines → a Host → Settings**, which opens the same Settings scoped to that Host:
the dialog on Desktop, `/pages/settings/<host>` in the browser. There is no second
copy on the Machines page. Nothing copies settings or credentials between
machines, falls back to This Mac, or queues writes while disconnected. Overview
continues to own reachability, reconnect, readiness, traffic logging and removal.
Desktop and the browser/mobile client show the same page. The browser's
configuration access lasts only while the page is open
([web client](web-client.md#configuration-access-and-lane-deletion)).

Configuration requires an explicit **Enable configuration access** action and a
signed `machine.configure` grant. Normal lane control does not imply this grant.
Desktop asks once per Host and account and remembers the answer until sign-out
([remote access](remote-access.md#connect-and-authorize)).
Older Hosts show an upgrade explanation instead of unsupported controls. Offline
and failed reads are unavailable states, not empty settings.

The **Host gate** (`HostGate`, built on the pure `hostSettingsStatus()`) shows one
notice until the section can render. Each connection state uses the Machines page's
reachability words (`machineReachability`) and fix command, plus the link's last
error: Host offline, not reachable yet or not reachable offer **Reconnect**;
Connecting… offers nothing; an identity mismatch says to remove and re-add the Host;
an incompatible Host says to update it; signed out offers **Open Phosphor account**.
A section that reads only the link (`host: 'connection'` in the index: Folders)
renders once the link is ready. For the others, a ready Host without the settings API
asks for `phosphor update`; one without the grant offers **Enable configuration
access**. Then the section loads (a skeleton), or its read failed (an alert with
**Retry**). Save and program errors show above the
section as alerts.

Each section is the shared view, editing the Host's own files. What a Host adds or
withholds:

- **Agent** adds the Host's context budget, automatic naming and directive policy,
  and its global instructions.
- **Accounts** and **Claude Code** sign in in a private terminal on the Host;
  Claude Code installs the provider and CLI by reviewed task and lists the saved
  and running lanes on each account.
- **Extensions** offers the headless recommendations and installs, repairs,
  updates and removes npm packages for the whole machine, each by reviewed task.
- **MCP Connectors** confirms command connectors and status checks first, and
  signs in in a private terminal.
- **Folders** needs no configuration access: it lists the folders the link
  reports, registers and unregisters within the Host's repository-change policy,
  which a refusal names, and reviews pi trust explicitly, which first asks for
  configuration access (a Host without settings support offers no review). Its
  Refresh reads the link's folders again.
- **Advanced** offers Pause and update (the Host's own signed `phosphor update`) and
  shows its pi, read-only paths, PATH and environment names: never values, never a
  raw-JSON editor.

Claude uses the same account routing, cooldowns and transcript bindings as
Desktop. Credentials stay in the Host's Claude credential store. Reauthentication
uses a fresh credential slot; the same email and organization adopts it, while a
different billing identity becomes a separate account. A lane move is explicitly
reviewed, requires its current control fence, stops and resumes a saved transcript,
and sends no prompt automatically. It can interrupt work and make the next turn
re-read the conversation at token cost. Failure may leave the lane stopped.

Supported authentication runs in an owner-private Host terminal. Follow the CLI's
instructions; loopback-only browser flows may need the browser on the Host.
Configuration sign-in streams remain open through authoritative verification,
including account registration. A terminal exit alone is not proof of success.
Package/CLI installs, stdio connectors, connector checks that may start servers,
and folder trust all require explicit review. Trust is never silently approved.

Global MCP may hold secrets. Folder MCP cannot contain environment values,
headers or OAuth client secrets; put these in a machine connector and override
its enablement in the folder. This Mac's connector writes apply the same rule,
and both machines write only https or loopback http URLs without credentials
([mcp.md](mcp.md#rules)); existing files keep loading. Inherited connectors are not silently replaced or
removed. A check runs `pi mcp list --json`; its reviewed status/tool counts expire
after 60 seconds and are invalidated by configuration or authentication changes.
Signing in never automatically executes a connector check. MCP Connectors is one
shared view on every machine ([below](#mcp-connectors)).

A Host's Agent defaults save themselves, as This Mac's do: a select or switch
when it changes, a text field on blur or Enter, and a number field as typed once
the value is in range (otherwise on blur or Enter). Each save sends only
the fields that differ, against the latest revision, one at a time; an edit made
while one is in flight follows it. Host policy and pi defaults are separate
commits, not an atomic multi-file save. A toast says where each save landed
("Saved on \<Host\> — applies to new lanes", or, for automatic naming on a Host
whose read lacks `namingLive`, "— applies after the Host service restarts"),
replacing the previous one; the section's save line shows "Saving…"
meanwhile. An invalid context budget or a half-filled
custom model is flagged in place and not sent. Edits preserve unrelated settings.
A Host whose Agent read carries `agentClearSupported` accepts `null` in a patch
to clear a value (the Host deletes the key); This Mac clears by sending
`undefined` to `pi:patchAgentSettings`. Both save through one merge
(`mergeAgentPatch`), so a cleared value is never written as `null`.

A change the Host refuses stays as a non-secret draft keyed by Host/folder, with
an error toast and a **Try again** / **Discard changes** banner; it is not
resent until asked, nor after a remount or reconnect. A changed server revision
blocks it until it is discarded. Section, machine, scope and Refresh controls, closing
the dialog and leaving the browser page wait for a save in flight, and ask before
discarding a refused draft.

The standard Host extensions are the headless standard packages (the Claude Code
provider, Subagents and Web access), offered with consent during guided setup.
Computer use is not provisioned on Hosts. Existing pins and resource filters are
shown, not silently reset.

A Host's Agent section is the same view as This Mac's ([Agent](#agent)). The
same pi settings apply to native and Claude providers. A failed model catalogue
can be retried; a custom model and thinking-only changes need no catalogue match.
In folder scope the Host adapter makes a second, machine-scope read, so unset
values show what the folder inherits; the folder's file still holds only its own
overrides. Unknown nested settings are retained on save. A Host whose read lacks
`agentBehaviorSupported` or `agentDirectives` hides those rows and shows one
"Update this Host" notice.

New lanes read pi defaults and resources; existing lanes are not silently
restarted. Folder editors keep saved values visible before trust, clearly marked
inactive; the runtime applies folder configuration only after pi trusts it. Host policy
(context budget, automatic naming, directive switches) applies to the next lane without
a restart; only an older Host without `namingLive` needs a service restart for naming.

**Instructions and directives** opens the Host's
own [global instructions](chat.md#global-instructions) in the same editor as This
Mac's, read and saved through the `instructions` settings section. Its four directive
switches and **What gets sent** preview are This Mac's, with the Host's label,
platform and repository names in the machine block, as its lanes receive them; they save on change, like the rest of the page, as Host
config (`agentDirectives`), which each lane start reads, so a save needs no restart
and running lanes keep the prompt they started with. There are no per-folder Host
directives. A Host without the section asks to be updated. Source URLs and non-allowlisted
package sources are hidden and read-only, not offered as guessed mutations.

## How a settings section is built

Everything lives under `libs/client-ui/src/features/settings/`.

- **The registry.** `sections/registry.ts` maps each section id to its views:
  `Device` for a device section, `Local` for This Mac, `Host` for a Host, and
  `scoped` when the scope line offers a folder. `SettingsPanel` renders `Device`
  alone, `Local` under the scope line, and `Host` inside `HostSectionProvider` ›
  `HostGate`. Nothing else in Settings branches on the kind of machine. A test keeps
  the registry in step with the navigation (`settingsIndex.ts`): a section lists on a
  machine exactly when it has that machine's view.
- **The machine frame.** `machine/` holds the scope line (`SettingsScopeLine`,
  `ScopeRow`, `HostScopeRow`, `ScopeRefresh` with `LocalRefresh` and `HostRefresh`),
  the gate (`HostGate`, `hostSettingsStatus`) and the Host plumbing: `useHostSettings`,
  `useMachinePrograms`, `machineProgramActions`, `HostProgramDialog`,
  `settingsAccess`, `machineSettingsDrafts` and the Agent draft helpers.
  `useHostSection()` gives a Host view its machine, settings read (`settings`),
  folder (`repositoryId`), programs, grant and refresh; `HostSectionProvider` owns
  the private-program dialog.
- **One view per section.** A shared section lives in `sections/<section>/`: a
  presentational `<Section>View.tsx` that takes a `source` prop; `source.ts`, its
  `<Section>Source` type; and one adapter hook per machine, `useLocal<Section>` and
  `useHost<Section>`. `index.tsx` exports `Local<Section>` and `Host<Section>`, each of
  which calls exactly one adapter. Leaves several sections use live in
  `features/settings/components/`.
- **The source contract.** A source carries `status` (`SectionStatus` from
  `sections/sectionStatus.tsx`: `'loading'`, `'ready'` or an error with `retry`,
  which the view shows through `SectionStatusNotice`), one `notice` slot
  (`SettingsNoticeProps`: an untrusted folder, a malformed file, "Update this
  Host"), at most five typed capability flags (`caps`), a `save` state for
  `SaveStatus` (immediate on This Mac, draft and revision on a Host), and its data
  and actions, typed on `@phosphor/shared/machine-settings*` wherever a Host type
  exists. A Host too old for a feature is detected by the missing field, never by a
  flag. A difference in the client, not the machine, is a `Platform` capability,
  never the form factor. Two sources differ:
  - **Connectors** carries no `status`: `servers` is null until the first read, a
    failed action (and on This Mac a failed read; on a Host the gate shows it) is its
    `error`, and it has a list of `notices[]` (a legacy or malformed configuration,
    an untrusted folder, an entry pi rejects).
  - **Folders** carries no `status`: This Mac lists its recent workspaces with no
    read, and on a Host the gate covers the settings read. Its one `notice` is a
    failed action.
- **Primitives.** `components/form/`: `Row` (its title names the control inside it),
  `Toggle`, `NumberField` (a typed value applies at once when it lies within the
  bounds, and is whole when the step is; anything else waits for blur or Enter,
  then is rounded to a whole number when the step is one and clamped, so a
  half-typed value is never saved), `TextField`, `Select` (native, so pickers and the `combobox` role
  work everywhere), `Segmented` (a radio group: one tab stop, arrow keys, Home and
  End), `SettingsNotice` (tone `info`, `warning` or `danger`, the last announced as an
  alert; a title, a body and one action), `SourceBadge` (Set here, Inherited from
  machine, pi default) and `SaveStatus` (idle, saving, saved, error with Try again and
  Discard, refused). Shared section views use these, not a raw `<select>`, a raw
  checkbox or `MachineUi.Card`.

## Search

The field at the top of the sidebar takes focus on open; Cmd/Ctrl+F returns to
it from anywhere in settings.

- **Index.** A hand-written list of every row and heading, kept as data with
  one module per section (`features/settings/search/rows/`) and assembled in
  order as `SETTINGS_INDEX` (`settingsIndex.ts`). Keybindings come from the
  Keybindings tab's own tables. Entries carry synonyms ("dark mode" finds
  Theme). Tabs whose package is not installed are left out.
- **Machines.** A machine section's row is indexed on the machines its section
  has (`local`, `host` in `TABS`), unless the row names its own (`on`). Every
  machine section has one shared view, so its rows are found on every machine
  that lists it. A row no folder renders (`machineScope`: the context budget,
  automatic naming, global instructions, and a Host's directives) switches the
  scope line to Machine when it is opened. Agent's rows come from its field table
  (`sections/agent/agentFields.ts`). A block only one machine has names it:
  `LOCAL_ONLY` for This Mac's raw files, maintenance, sandboxes and the Claude
  Code proof, `{ host: true }` for a Host's update and runtime.
- **Checked.** `settingsQuery.test.ts` reads the section views (`tabs/`,
  `sections/` and `components/`, recursively) and any data module a section
  declares, such as a field table whose `title:` entries the view renders. It
  checks the index against them in both directions, so renaming a row without
  updating the index fails CI.
- **Query.** The model picker's grammar (`parseQuery`): words AND together
  across title, section, tab and synonyms, `"quoted phrases"` stay whole,
  `-word` excludes, separators are optional ("autocompaction"). Title prefix
  matches rank first.
- **Results** replace the panel while there is a query, grouped by tab, best
  group first, with matched text emphasised and a keybinding's keys beside it.
  Each sidebar tab shows its match count and dims without any. Up/Down move,
  Enter or a click opens.
- **Opening a result** shows its tab with the query painted over the live
  controls (the find bar's CSS Custom Highlight API, so React's DOM is never
  touched), scrolls to the setting and flashes it. A tab that loads its
  values over IPC is waited on for up to two seconds. Picking a tab in the
  sidebar while searching shows it the same way, without the jump.
- **Escape** clears the query first, and closes settings the second time.
  Reopening settings starts with an empty search.

## Appearance

- Theme: Light / Dark / System. Switches live across the app, Monaco, xterm,
  Shiki and Mermaid.
- **UI scale** zooms text, icons and spacing together (the same value
  Cmd/Ctrl+plus/minus/0 nudge). Separate chat, editor and terminal font sizes,
  each applied live.
- Mono font: JetBrains Mono is bundled; the other entries use whatever the OS
  has.
- All of it is Phosphor's own state. Nothing here touches pi.

## Writing

Spelling and autocomplete in Phosphor's own text fields
(`AppPrefs.writing`, `libs/shared/src/writing.ts`). Neither calls a model and
nothing leaves the machine.

- **Check spelling** (on by default) switches Chromium's spellchecker for the
  app's session (`session.setSpellCheckerEnabled`, applied at launch and on
  change). macOS uses the system spellchecker and its language setting;
  Windows and Linux use Hunspell, whose dictionaries Chromium downloads from
  Google's CDN. Typed text is never sent.
- **The right-click menu** is `features/writing/TextFieldMenu.tsx`: one
  window-level `contextmenu` listener for textareas and text inputs. It stands
  aside when a component already opened its own menu, and skips Monaco and
  xterm, password fields and disabled fields. Suggestions come from the
  preload's synchronous `spellingSuggestions` (`webFrame.isWordMisspelled` /
  `getWordSuggestions`), not from the `context-menu` event's
  `dictionarySuggestions`, which came back empty on macOS with the spelling
  language set to Automatic (electron#24455) while `webFrame` answered.
  _Add to dictionary_ also writes to the OS dictionary on macOS and Windows,
  which other apps share. Cut / Copy / Paste / Select all run in main
  (`writing:edit` → `webContents.paste()` and friends), so a paste still fires
  the field's paste event (images, list continuation).
- **Autocomplete** (off by default) shows ghost text in both composers
  (`ComposerField`). While it is on, every prompt a composer sends is kept in
  `<userData>/writing/prompts.jsonl` (mode 0600, the newest 2,000, no `/`
  or `!` commands, nothing over 2,000 characters). It starts empty: pi's
  session files are not read, because they also hold messages no person typed
  (subagent supervisor prompts, test runs). The model is
  `lib/writing/predictor.ts`: an earlier prompt the current line starts (after
  12 typed characters), else word counts with two words of context, else your
  vocabulary from three typed letters. Only confident guesses show; the
  thresholds and how they were tuned are in that file.
- **Learned prompts** shows the count and clears the file.

## Agent

One view on every machine (`sections/agent/AgentSettingsView.tsx`), fed by This
Mac's adapter (`useLocalAgent`) or a Host's (`useHostAgent`). It writes pi's own
`settings.json`: the scope line's **Machine** writes the machine's global file
(`~/.pi/agent`); **Folder** writes that folder's override (`<ws>/.pi/settings.json`
on This Mac, a registered folder on a Host). Each scope is read **unmerged**, so a
folder edit never bakes inherited machine values into its file. Each field's
place, control, bounds, step and pi default come from one table,
`AGENT_FIELDS` in `@phosphor/shared/machine-agent-behavior`, which the Host's
validator reads too; titles and descriptions are in `sections/agent/agentFields.ts`.

Every row shows the value this scope sets, else the machine's (folder scope),
else pi's own default, with a badge that says which: **Set here**, **Inherited
from machine** or **pi default**. **Reset** clears a value set here, so it inherits
again: This Mac sends `undefined`; a Host sends `null`, and only a Host whose read
carries `agentClearSupported` offers it. A choice (the model, the thinking level,
the delivery modes) lists the unset value first, named by what it falls back to
(**pi default (medium)**, **Machine (high)**). While nothing is set here it is
selected, so any concrete value can be pinned, including the one shown; where
Reset is offered, choosing it is Reset. `defaultProvider` and `defaultModel` are
read each on its own: a file that sets only one shows it as set here, with Reset
and the id in Custom model.

The groups, in order:

- **New lanes.** **Default model** is a catalogue choice from the machine's own
  catalogue (This Mac's `modelCatalogue`, a Host's `machineCatalogues` cache, shared
  with its pickers); a saved model the catalogue lacks stays listed. **Custom
  model** takes any provider id and model id pair the machine has configured,
  including a custom `models.json` or a local endpoint no catalogue lists. It saves
  the whole pair once both ids are filled and the user presses Enter or **Use**, or
  leaves the disclosure; moving from one id to the other saves nothing. Default
  thinking level (off · minimal · low · medium · high · xhigh · max). **Name new
  lanes automatically**: `LanePrefs.autoName` on This Mac, the Host's
  `autoNameLanes`. A Host whose read lacks `namingLive` says a change applies after
  its service restarts.
- **Behaviour.** Hide thinking blocks; steering and follow-up delivery (one at a
  time, or all).
- **Compaction.** Auto-compaction, the context budget, reserve tokens and keep
  recent tokens (0–1,000,000, in steps of 1024). Compaction applies to every
  provider, including Claude Code. The **context budget** is one picker on every
  machine (default 200k; 400k; model maximum; or custom, 100k–1M, where a bare
  `500` means 500k, previewed beside the field). This Mac keeps it as a
  Phosphor pref, and a failed save puts the old value back with an error; a
  Host keeps it in its config. It reaches running lanes at their next safe
  boundary on both. See [One context budget](cli-providers.md#one-context-budget).
- **Retry.** Retry on transient errors; max retries (0–100); base delay
  (0–1,000,000 ms, in steps of 250).
- **Instructions and directives.** What Phosphor appends to lane system prompts,
  shown composed before it is sent (**What gets sent**). A prompt you cannot read
  is one you cannot debug. The four blocks are switches, with no free-text field.
  **Global instructions → Edit instructions** opens the machine's
  [global instructions](chat.md#global-instructions) file. On This Mac, text from
  the retired "Your own text" field that could not move into it is listed with a
  copy button until dismissed.

The context budget, automatic naming and global instructions are machine-wide,
so folder scope hides them and says so. Directives follow the scope line too:
on This Mac a folder keeps its own switches (**Clear this folder's override**
returns it to the machine's); a Host has no per-folder directives.

One notice slot sits under the heading. On This Mac: a target file that is not
valid JSON disables editing rather than editing best-effort, and routes to
Advanced to repair it by hand (main never overwrites a config it could not
parse); a folder pi does not trust is named, since pi ignores its settings until
trusted (the trust answer comes from `mcp:readConfigs`). On a Host: an untrusted
folder, or "Update this Host".

This Mac saves each edit at once; a Host saves through its draft and revision
engine ([above](#host-machine-settings)). One save line shows either. A failed
read shows an error with **Retry**. A Host folder also reads the machine's values
it inherits; the section waits for that read, and a failed one is the section's
error with **Retry**.

- This Mac's saves use the Host's writer (`libs/session-runtime/src/pi/settings-file.ts`):
  locked per file and atomically replaced. The client sends no revision; main
  takes it inside the lock just before writing, so a change made outside since
  the page read the file is not refused. An edit merges only its own key, so an
  outside change to another key survives and one to the same key is overwritten
  without a warning; a raw editor's save replaces the whole file. This Mac's
  policy (`DESKTOP_FILE_POLICY`) saves through a dotfile symlink, so the link
  survives, and keeps each file's mode. `settings.json`,
  `models.json`, `mcp.json` and their raw editors all write through it.
- pi settings apply to **new** lanes. The context budget is the live-session
  exception described above.

## Accounts

One view on every machine (`sections/accounts/`: `ProviderAccounts` over
`useLocalProviders` on This Mac and `useHostProviders` on a Host). The
subscription routes are distinct (`SUBSCRIPTION_PROVIDERS` in
`libs/shared/src/subscription-providers.ts` is the catalogue, shared with the
Host's `phosphor providers` and joined onto a Host's rows in the client):

| Account        | Route                                                                      | Requirement                   |
| -------------- | -------------------------------------------------------------------------- | ----------------------------- |
| ChatGPT        | pi's native `openai-codex` OAuth; no Codex CLI bridge                      | Plus or Pro                   |
| Claude         | Authenticated Claude Code CLI through `@saccolabs/pi-claude-cli`           | Pro or Max; provider ≥ 0.10.0 |
| GitHub Copilot | pi account login on github.com; Enterprise Server uses pi's terminal login | Copilot subscription          |
| Kimi           | pi's `kimi-for-coding` account login                                       | Kimi For Coding plan          |

Provider limits and billing rules still apply. Native Anthropic OAuth is a
separate route from Claude Code subscription sessions, and the tab says it
bills extra usage. xAI, OpenRouter and Radius sign-ins draw on a credit
balance, not an included allowance.

- One row per provider pi can sign into, grouped by what signing in spends (a
  plan you already pay for, billed per token, then other providers, such as a
  Host's API-key default), each with what it requires and its caveat. Every row
  says **Signed in**, **Not signed in** or **Could not verify** (the check could
  not run), from `pi auth check --json`; Claude accounts use the same words.
- Sign-in differs by machine (`caps.signIn`). On This Mac, Sign in drives pi's TUI
  off-screen. On a Host it opens a private terminal there (`HostProgramDialog`,
  "Provider sign-in on …"), where you type `/login <id>`, and a Host never says
  whose account a provider holds. The Machines page lists the same rows read-only
  and links here.
- That off-screen pi runs in an empty folder under userData (`pi-sign-in`)
  with `--no-approve --no-extensions`, because any startup dialog swallows the
  typed `/login`. Home is not neutral: pi treats its cwd as a project, and
  project config there can open a startup dialog. The login
  terminal uses the same folder and `--no-approve` but keeps extensions.
- A sign-in that stops at a screen it does not recognise logs that screen to
  the debug log (`[login]`), and an ended flow (signed in, cancelled or
  failed) frees the row and re-reads auth.
- A signed-in row also shows **which account** when the credential is a JWT
  that names one (ChatGPT/Codex today). The email claim is read inside the
  main process; the credential itself is never stored, logged or sent to the
  renderer. Providers with an opaque credential show "Signed in" and nothing
  more.
- **Sign in again** (switching accounts) finishes when the credential
  _changes_, not when `pi auth check` first reports ready: the old credential
  already answers ready a second after pi prints the URL.

This section is pi's own `auth`. The **Claude Code** provider keeps its own set
of logins under Extensions → Claude Code, and Accounts ends with one link row to
that page.

### Phosphor account

Optional GitHub sign-in lives in the sidebar footer and in **Settings → Phosphor
account**, which shows the signed-in profile with Sign out (Sign in with GitHub when
signed out) in Desktop and the browser.
It lets you add and manage Hosts on the Machines page
([remote-access.md](remote-access.md)). Local work never needs it.
Launch reads the plain profile. A signed-out launch makes no control request
and never reads the keychain. An encrypted credential is read only when its
session file exists and a signed-in request needs a token.

- **GitHub through Supabase Auth**, with no email. Main runs PKCE: the system
  browser opens Supabase's authorize page, and Supabase sends it back to a
  one-shot server on `127.0.0.1`, at a port the OS picks and a random path only
  that sign-in knows. Main exchanges the code with its verifier
  (`apps/desktop/electron/account/`).
- **The renderer sees who, never a token.** `account:get` and `account:changed`
  carry the GitHub login, name, email, an optional main-fetched avatar data URL and whether
  the sign-in is remembered.
  GitHub's own token is dropped on arrival.
- **Remembered with the OS keychain** (`safeStorage`): the refresh token is
  encrypted in `<userData>/account/session.bin`, beside a plain `profile.json`,
  both readable by the user alone. On Linux desktops Chromium does not recognise,
  Phosphor checks the session bus before startup and selects Secret Service or
  KWallet when present, unless a password store was explicitly chosen. When
  Chromium selects no keyring (`basic_text`), the refresh token is saved
  unencrypted in `session.txt` (0600 in the 0700 account directory). If a
  keyring is selected but unavailable, or the backend cannot be identified, the
  sign-in lasts until Phosphor quits. The account view reports: "Saved in a file only your user
  can read, because no keyring is running." Unsafe files are refused and removed.
  A successful refresh with a keyring saves it encrypted and removes the plain
  file. Sign-out removes both token files, the profile and the cached avatar.
  Every keychain call uses `safeStorage`'s async API, so a macOS Keychain prompt
  never holds the main process: the window opens and Quit works while the prompt
  waits. A sign-out during the prompt still wins: the files go at once, a
  save that answers late writes nothing, and the token read before the prompt
  is used only to revoke.
- **Sign-out always works here** and tells Supabase when it can. A sign-out or
  cancel wins over anything still in flight: a session that arrives late is
  revoked, not kept. The screen shows signed out at once, while the revocation
  is still on its way, so quitting waits for requests to Supabase already
  started (up to 10 s, then quits anyway and logs it).
- **Avatar**: main fetches only HTTPS GitHub avatars from
  `avatars.githubusercontent.com`, without credentials or redirects, with a
  256 KiB cap and a 10 s timeout. Raster image content types only. The
  owner-only cache sits beside `profile.json` and is tied to the account id
  and avatar address. It shows a face at once; each sign-in and launch still
  fetches once, because GitHub keeps the address when the picture changes.
  The renderer loads a data URL under its existing CSP. Failure uses initials
  on a deterministic theme colour.
- **Every window shows what main pushes** on `account:changed`. An action's own
  reply is not applied, because it can be older than a push from another window.
- **Unpackaged builds only:** `PHOSPHOR_SUPABASE_URL` and
  `PHOSPHOR_SUPABASE_KEY` point at a local stack, and
  `PHOSPHOR_ACCOUNT_NO_KEYCHAIN=1` keeps e2e runs off the keychain. A packaged
  build always signs in to the hosted project.

Phosphor's main-process log is `~/Library/Logs/Phosphor/phosphor.log` on macOS
and `~/.config/Phosphor/logs/phosphor.log` on Linux, rotating at 5 MB. Account
sign-in start, browser opening, callback, finish, failure class, cancellation,
refresh and sign-out use `[account]`. The log records the user id and GitHub
login, never an email, token, callback code or exception message. `[control]`
records control API calls; `[machines]` records Realtime and fetch observations.
See [Tracing a machine](remote-development.md#tracing-a-machine) for correlation and
liveness rules. An E2E profile writes only to its own log folder.

## Extensions

pi package management: extensions, skills, prompts and themes, in one view on every
machine (`sections/extensions/`: `PackagesView` over a `PackageSource`, with
`useLocalPackages` for This Mac and `useHostPackages` for a Host). Extensions is
**scoped**: with a folder chosen in the scope line, its packages are listed below the
machine's. Reads come from pi's settings files and install dirs; every action runs
pi's own package manager (`pi install` / `pi remove` / `pi update`) on that machine.

- **Recommended**: the standard packages (`STANDARD_PACKAGES`,
  `@phosphor/shared/standard-packages`), the one list This Mac, a Host and guided
  Host setup share. A card says **Added** when the package is installed, offers
  **Repair** when pi's settings name it but it is missing, and **Add** otherwise
  (`standardPackageState`, matched by package name, so pinned versions and a Host's
  redacted specs still match). A Host offers only the `headless` ones: computer use
  needs a desktop session. The Claude Code card says when the machine's `claude` CLI
  is not on PATH (a Host's from `hosts:claude`).
- **Installed** lists, for the machine and for the folder in scope. Each row shows
  the version, a `vX available` chip when the machine checks the registry, and what
  the package contributes: by name on This Mac (skills with a **View in Skills**
  jump, prompt commands, extensions, themes), as counts from a Host. View in Skills
  closes Settings and opens the Skills page on that machine (`openSkillsOn`). A
  declared but missing package is labelled "installs on next session start" and
  offers **Repair installation**. A "filtered" row has settings-level resource filters.
- **Add a package** by spec, plus **Update all** where the machine supports it.
  Packages run with full system access, and the view says so. **Remove** always
  asks first.
- Contents come from the install dir (`libs/session-runtime/src/pi/package-resources.ts`).
  A `pi` manifest lists folders and globs, not resources, so each entry is
  expanded the way pi expands it (`"skills": ["./skills"]` is every bundle in
  that folder) and `!pattern` exclusions are applied. A kind the manifest
  omits is empty even if the folder exists, because pi will not load it.

The machines differ only in the source's capabilities:

| Capability     | This Mac                                            | A Host                                                   |
| -------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `anySource`    | npm, `git:` or an absolute path                     | npm only                                                 |
| `projectScope` | installs into the folder in scope, or the machine   | the whole machine; folder packages are listed, read-only |
| `updateAll`    | `pi update --extensions`                            | none                                                     |
| `versionCheck` | registry lookup, never blocking the listing; Update | none: Update is always offered on an installed package   |
| `headless`     | every recommended package                           | the headless ones                                        |

This Mac runs an action at once and streams its output under the view. A Host runs
each action as a reviewed task (`package.install` / `update` / `remove`) in a
private terminal on the Host, which needs the Host's `terminal` capability; the
review asks before anything runs, and the section reads again when the task ends.

Four packages contribute an item nested under Extensions
([which are listed](#sections-and-capabilities)):

### Claude Code (`pi-claude-cli`)

Routes model calls through the Claude Code CLI, billing your Claude Pro/Max
plan; its models appear in the picker under the `pi-claude-cli` provider. One
page on every machine where Claude can run (`sections/claude-provider/`:
`ClaudeProviderView` over `useLocalClaudeAccounts` or `useHostClaudeAccounts`),
listed whether or not the package is installed. In order: **Health** (package
and CLI, each with **Install provider** / **Update provider** when it is missing
or too old; on This Mac also both versions and update rows; on a Host
**Install Claude Code** for a missing CLI, as a reviewed task), **Accounts**,
pi context ownership guidance (Claude sessions follow
the Agent tab's compaction settings and context budget), **Prove it end to end** (one tiny
print-mode prompt through the CLI, the login and the extension at once, because
"installed" and "working" are different claims; This Mac only), and **When it
fails**. See
[cli-providers.md](cli-providers.md).

- **Accounts** keeps several Claude logins and routes one to each new session
  (`specific`, `ordered`, `round-robin`). An account is held back from new
  sessions while the provider reports it rejected, at its window, or
  **spending overage credits**. A running session keeps its account: the
  credential is fixed at spawn. The context popover names the account a lane
  is spending and shows that account's own plan usage.
- Routing and the pinned account are radios on every machine. **Refresh usage**
  re-reads every account's cooldowns (`claude.refreshUsage` on a Host).
- An account row shows its sign-in state (Signed in / Not signed in / Could not
  verify), its lane count and its 5-hour use. It **opens** onto its usage
  windows (read under that account's own CLI config dir, so they cannot show
  another account's numbers; a Host shows its last reading, and **Check again**
  asks the machine's CLI anew on every machine) and its lanes: the live sessions
  on This Mac, the saved and running lanes on a Host, each with **Open lane**.
  No reading yet says so and never draws a meter. A lane can be restarted on the same account or moved to another,
  after a confirmation; both respawn it from its session file, which is the only
  way an account can change. Move targets follow one rule everywhere (`moveTargets`
  in `lib/claudeGateway.ts`, also used by the composer's account switcher): every
  other account not reported signed out, held ones last.
- **Remove** asks first ("Sign out and remove"), and is disabled while lanes on
  the account are running. Removing signs the account out, so the machine
  refuses it while live sessions use it ("Stop or move this account’s live
  sessions before removing it."); the refusal shows under the list.
- On a Host, adding or re-authenticating an account opens a private terminal
  there; a Host holds at most 16 accounts.

### Web access (`pi-web-access`)

Search, fetching and PDF extraction for sessions, written to the package's
`web-search.json` on the machine (`sections/web-access/`: `WebAccessView` over a
`WebAccessSource`). Common search providers get first-class fields
(`WEB_ACCESS_PROVIDERS`, `libs/shared/src/web-access.ts`); the rest stay
reachable through the file itself. The file holds API keys, so both machines report
only which keys are configured, never their values: This Mac through
`pi:webSearchConfig`, a Host through its `resources` read (`webAccess`). A key is set
or replaced by value, and cleared (on a Host, the `webAccess.key` change). **Edit raw
JSON…** is This Mac's explicit way to see the file's contents; a Host has no raw
editor. A Host whose read lacks `webAccess` shows "Update this Host" and no fields. A
malformed file makes the fields read-only. Every save of the file writes it 0600.

### Subagents (`pi-subagents`)

A searchable guide to parent/child responsibilities, foreground and background
work, source precedence, context, permissions and results. Configuration stays
with its owner: Pi settings for defaults and profile overrides, Markdown for
agents, extension `config.json` for runtime limits, and the Agent section for
delegation directives. On This Mac the global settings button opens the raw
editor; a Host shows the guide without it. The page does not launch work and is not
proof that a particular session loaded the package.

### Computer use (`@injaneity/pi-computer-use`)

Read-only: what the package adds (observe windows, search UI elements, click,
type, scroll) and the accessibility permissions it needs. A Host never offers the
package, so it lists this item only when the package is installed there; the page
then says that permissions are granted at the Host's own console.

## MCP Connectors

Top level, right after Extensions and its package tabs: MCP is built into pi,
so connectors are not configuration for a package.

One view on every machine (`sections/connectors/ConnectorsView.tsx`), scoped by the
scope line: **Machine** is the machine's `mcp.json`, **Folder** the chosen folder's
`.pi/mcp.json`, where a machine connector can only be switched on or off.

- **Connected**: every server pi resolves in that scope, with one status vocabulary
  (**Up · N tools**, **Needs sign-in**, **Down**, **Not checked**, …), an
  **Enabled** switch, Sign in and Sign out for OAuth servers, and Remove, which
  asks first and signs an OAuth server out before removing it. **Refresh & test
  all** rereads and checks, and **Checked** under it gives the time the last full
  check finished, on every machine. Signing in runs `pi mcp login`; Phosphor holds no
  tokens and only writes `mcp.json`.
- **Add a connector**: the curated OAuth catalog (Linear, Notion, Braintrust,
  Datadog, Supabase, Questrade, Fellow, Slack), minus what is configured. Add
  writes the entry, then starts its sign-in: on a Host once it confirms the save,
  as the reviewed sign-in task (where Host terminal access is granted).
- **Add custom server…**: a remote URL with an optional Authorization header
  (Machine scope only), or a command with one argument per line.
- **This Mac only** (`caps`): per-server **Test**, tools and tool visibility,
  lane status, Edit, and **Advanced** with both config files and the raw JSON
  editor. While pi-mcp-adapter or its config is still present, This Mac shows
  only the migration card.
- **A Host** confirms every check and every command connector first, never
  checks on its own, and runs sign-in in a private Host terminal.
- All of it is specified in [mcp.md](mcp.md).

## Lanes

A device section: how this client shows lanes and names their branches, for
every machine's lanes it starts or lists. It is the same whichever machine
Configure chooses, and the browser keeps it
([web client](web-client.md#memory-and-offline-behavior)).

- **Lane markers** (Auto, Manual or Off) and **PR status on lanes**
  (`LanePrefs`). See [lanes.md](lanes.md#preferences).
- **New lanes**: the **Branch prefix** (`WorktreePrefs.branchPrefix`) and the
  **Branch name length** (the slug cap, clamped in the renderer and main; the row
  previews a real slug). A Host lane's branch uses both, as This Mac's does. With
  local lanes, **Give each chat its own branch** is the same switch as the
  "worktree" checkbox in the branch menu; Host lanes always get their own
  worktree, so the browser has no such row.

Titles are always 2-5 words and at most 60 characters. Automatic naming is the
machine's, under Agent.

## Folders

The folders a machine runs lanes in, as one view on every machine
(`sections/folders/`: a `FolderSource` from `useLocalFolders` or `useHostFolders`).
Removing a folder from either list asks first (`confirmFolderRemoval`) and never
touches files.

- **This Mac**: its recent folders. **Add folder** opens the native picker, as
  the sidebar does; the folder opens on the home screen and joins the list.
  **Remove** forgets the folder and touches nothing on
  disk. Remove is the same action as the sidebar kebab's
  **Remove from sidebar**: it closes the project's idle chats and lanes (a
  live chat would otherwise hold its group in the sidebar; transcripts stay
  and reopen from disk), refuses while one of them is mid-turn, steps the home
  screen off the folder, and forgets the launch-resume target if it was inside
  it, so the next launch does not reopen and re-add it. Reordering lives in
  the sidebar, on each workspace group's kebab, where you can see the order
  you are changing.
- **A Host**: its registered folders, the only folders its lanes run in.
  **Add folder** browses the Host's own folders; **Unregister** and **Review
  project trust** (pi's trust prompt in a private Host terminal) are per row.
  Changing folders needs the `workspaces.write` capability; without it the list
  is read only. A Host whose config turns off `allowRepositoryChanges` refuses
  the change, and the refusal says so.
- **Sandboxes** (This Mac only): the scratch folders behind "No folder", listed apart from
  recents. Each is minted under a random `adjective-noun` name and shows its
  item count and last use. **Rename** changes the folder on disk and moves its
  chats with it — a sandbox IS its path, so the rename re-points recents, the
  launch-resume pair, and every pin, marker and unseen badge on its sessions.
  "Its chats" means the whole subtree: a sandbox that is a git repo has lanes,
  each its own cwd with its own pair of transcript directories, and moving only
  the root's pair orphaned every lane chat. Running chats in the sandbox are
  **closed** as part of the rename, and the prompt says how many before you
  commit. They have to be — pi cannot keep working in a folder that has moved,
  and since nothing reclaims an idle session's process, refusing instead meant
  a sandbox you had actually used could not be renamed for the rest of the
  launch. Deleting moves the folder _and its chats_ to the Trash, and is still
  refused while anything is running anywhere inside it. An empty sandbox is
  reused.
  A rename also **rewrites the cwd stored inside each session file**, because
  pi refuses to resume a session whose stored cwd is gone — it prints
  `Stored session working directory does not exist` and exits 1 before the RPC
  loop starts, which reads as a chat that simply will not open. Correcting the
  cwd on the scan is not enough: that fixes what Phosphor passes pi, not what
  pi reads back out of the file. See
  [ui-shell.md](ui-shell.md#left-sidebar-claude-desktop-style).

## Optimization

Headroom, the local tool-result compression proxy. Opening the tab probes
`/health` and looks for the binary but never starts the proxy and never
installs anything. Every action is a button.

- **Status + lifecycle**: installed or not, version, whether the proxy runs and
  on which loopback port, and whether Phosphor owns it or _adopted_ one already
  running (Stop is only offered for a proxy we own). Install runs `uv` with
  streamed output and names the manual command.
- **Compress tool results**: large JSON tool results are restructured
  losslessly before entering context, or left alone. Never summarized. Applies
  to new sessions. Compressing plain search/log output is deliberately off:
  that direction is only reversible through Headroom's retrieval store, which
  needs a Phosphor retrieve tool first.
- **Savings** for the current workspace: tokens saved, lanes with savings, a
  per-lane bar chart read from the session files.
- **Advisor**: findings computed from your session files and configuration.
  Never a model call, never an action taken for you. Each row is tip / warning
  / serious and jumps to the tab that fixes it.

## Voice

A device section, listed where the client can dictate with a local speech model
(`localVoice`: Desktop, not the browser). Dictation works in a Host lane's composer
as in This Mac's, so Voice shows whichever machine Configure chooses.
Voice input on or off, and the model (Moonshine Tiny or Base, English only).
Turning it on downloads the model and turning it off deletes it; the tab
shows progress, readiness or the failure with Retry. Behaviour, download and
privacy rules are in [voice.md](voice.md).

## Advanced

One view on every machine (`sections/advanced/`: an `AdvancedSource` from
`useLocalAdvanced` or `useHostAdvanced`). Each block renders when its machine
reports its data. A failed load says why and offers **Retry**, as do Maintenance
and the raw editor.

- **pi health**, on both: where pi is installed, its version and the minimum
  version Phosphor supports (`MIN_PI_VERSION`); a pi older than that reads
  **too-old** on every machine. Then **pi agent directory** and the
  **Executable search path** pi runs with (`PiHealth.path`, `PiHealth.agentDir`;
  the login shell's PATH on This Mac). A Host reports its pi as additive
  `advanced.pi { version, path, agentDir }`; a Host without it shows **Update this
  Host to see its pi** and its agent directory and PATH only.
- **Updates and version**, first on both, in the same rows (`MachineRuntimeRows`):
  This Mac's Phosphor version and platform (`app:about`) with the app's own update
  row, the one About shows (**Check now**, then **Restart to update** or
  **Download**); a Host's version, platform and config path with **Pause and
  update**, which runs the Host's own signed `phosphor update` as a reviewed task
  and needs Host terminal access. Both name the platform alike (macOS, Linux,
  Windows); a version This Mac cannot read shows as unknown beside its update row.
- **Environment availability**, a Host only: each allowlisted variable's name and
  whether it reaches pi, never its value.
- **Raw file editors**, This Mac only (Monaco JSON) for `~/.pi/agent/settings.json`
  and `models.json`, with a "restart sessions to apply" note. The escape hatch the
  Agent tab points at when a file is too broken to edit structurally.
- **Maintenance**, This Mac only: a periodic sweep for worktrees whose branch
  already landed. It always _measures_ ("N of M worktrees reclaimable") and only
  deletes once "Delete automatically" is on. Interval (≥15 min) and a grace period
  (a merged lane is kept this long after its last use) are configurable. See
  [lanes.md](lanes.md#reclaiming-lanes-automatically).
- **Local pi resources**, This Mac only: a read-only listing of the loose
  extensions, prompts and themes pi discovered. Packages are the Extensions tab;
  skills have their own page ([ui-shell.md](ui-shell.md#global-surfaces)).
  `auth.json` is never read or displayed.

## Keybindings

A static sheet of every shortcut in four groups: **App**, **Chat**,
**Formatting**, **Editor & terminal**. Not remappable yet. Spellings follow
Claude Code and Claude Desktop where a binding exists there (Esc Esc rewind, ↑
prompt history, ⌃O verbose output), so muscle memory carries over. Terminal
copy/paste differs per platform because Ctrl+C must stay SIGINT off macOS.

## About

App version, an on-demand **Check now** for updates (the sidebar pill only
appears once there is something to act on, so this, and This Mac's Advanced, is
the way to ask "am I current?"), pi's version and path, platform/arch, Electron and Node versions,
and the bundled font licenses. A pi newer than the line Phosphor is verified
against gets a warning: newer minors usually work, but protocol additions may
not be surfaced yet.

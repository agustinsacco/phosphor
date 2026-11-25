# Host protocol

The shared wire contract is `libs/shared/src/host-protocol.ts`; grants are in
`libs/shared/src/host-grant.ts`. [Remote access](remote-access.md) explains the flow;
[Host API](host.md#api) owns listener admission and [Desktop](remote-desktop.md) owns
connection recovery. Control is never in the lane data path.

`libs/shared/src/remote-host.ts` validates hello compatibility and enrolled Host
identity and builds Host-qualified resource keys. Hello parsing alone is not
authentication; trusting a connection also requires the enrolled key proof.

## Wire compatibility

Control, Hosts and clients update independently. In v1, old readers reject unknown
capability names and frame types: keep grant `caps` on the eight legacy names, do
not add names to hello or ready capabilities, and do not send new Host frame types.
Advertise new features with additive ready booleans instead; an absent marker means
unsupported. Keep the lanes topic within 64 repositories and 1000 lanes, including
the 1000-entry bounds on delta upserts and removals.

## Frames and streams

`libs/shared/src/host-protocol.ts` is the entry for protocol v1; its allowlist,
parsers and limits live in `libs/shared/src/host-protocol/`. The Host serves hello and grant authentication on `/v1/hello`
and `/v1/stream`, on loopback port 47615 (configurable as `api.port`). It
announces session capabilities only when supplied a lane service. Without it,
the API remains authentication-only. The network adapter multiplexes authenticated
subscriptions, commands, receipt status and calls over each socket. Adapter tests
use a fake lane service and loopback sockets. The contract kit also runs every
scenario against the real in-process Host with a temporary SQLite store, signed
grants and a scripted runtime port. The fake Host passes the same suite. A separate
fake-pi subprocess test proves runtime startup, streaming, stop, resume and drain.
Tailscale Serve can expose the loopback listener, never Funnel.
[Host API](host.md#api) owns its admission, limits and close codes. [Trust boundary](remote-access.md#trust-boundary) and
[Host machine identity](host.md#machine-identity) apply to this protocol too.

Host, lane, client and request ids are UUIDs. Repository ids, connection ids
and process epochs are 16 lowercase hex characters. Lane ids survive restarts;
stream cursors do not. A cursor names the epoch and last event held, with 0
meaning none. A new epoch or replay gap requires a snapshot. Lane events are
ordered by the Host, not by Desktop or control. Snapshots include settled
messages, in-flight events, dialogs and the latest status, widget and title
state. stderr never crosses the wire.

Text frames carry one JSON object. `auth` establishes or renews permission;
`ready` proves the enrolled Host with a challenge signature. `subscribe` and
`unsubscribe` manage lane summaries and individual lane streams. `call` and
`result` carry feature RPC, including revision-checked machine configuration.
`command`, `receipt` and `receipt-status` handle lane mutations and fixed-purpose
machine programs. The persisted control fence rises on takeover or release. Only the
controller can mutate a lane with its current fence. The first mutation of an
unowned lane acquires control and raises the fence before pi events. Every
viewer sees control changes at the same stream position. Disconnecting does
not release control.
A request id deduplicates one action. Receipts are pending, done, failed,
rejected or unknown. Unknown means the outcome is uncertain, not permission to
repeat the action with a new id. A pi command unanswered after 30 seconds becomes
unknown. `lane.create` has a 120-second Host answer window once dispatched, to
allow for a worktree checkout and pi startup. A later completion cannot replace
an unknown receipt or send another terminal receipt.

The pi commands a controller may send are `LANE_PI_OPS`: prompt, steer,
follow-up, abort, abort-retry, model, thinking level, compact, session name,
`clear_queue`, the steering and follow-up modes, auto-compaction, auto-retry,
`bash` and `abort_bash`. The client (`laneOperation` in `libs/host-client`) and
the Host (`toPiCommand`) both test `isLanePiOp`, so the list is written once;
anything else is refused
`unsupported`, which the client reports as "updating the Host may help".

`bash` needs `sessions.control`, as a prompt does, and adds no authority beyond
it: a controller can already ask the agent to run the same command. It does not
need `terminal`, which is the Host's pty feature: pi runs the shell itself, so a
Host without node-pty runs it too. It skips pi's `tool_call` hooks, including an installed permission
gate, but the controller is who answers that gate's dialogs anyway. Its output
returns in the receipt's data (pi keeps the last 50 KB), so output above the
receipt-data cap reports as done without output. A shell can outlast the
command deadline; its receipt is then `unknown` and the client shows the
command as unconfirmed, not failed, with a Stop that sends `abort_bash`. Its
output reaches viewers with the lane's next snapshot. Commands that move pi to another session file
(fork, clone, new and switch session) stay refused.

`lane.exportHtml` is a call, not a command: a viewer need not control the lane,
but its grant needs `sessions.control`, because the export carries more than
`lane.messages`: pi's system prompt (context files, the skills catalogue with
Host paths), tool definitions and the whole session tree. It exports running
lanes only, takes only the lane id and answers `{ html }` within the command
deadline; the Host picks where pi writes and removes the file
([Host](host.md#session-commands)).

Two `sessions.read` calls on running lanes serve the Subagents pane, so a viewer
needs no control:

- `lane.subagentHistory` takes the lane id and answers `{ entries, leafId }`:
  only the active branch's subagent calls (text dropped), subagent results and
  supervisor notices, re-chained root to leaf (`subagentEvidence` in
  `@phosphor/shared/subagent-evidence`). It is refused `too-large` above half an
  outbound frame. This query does not transfer the session file; explicit lane
  moves below are the exception.
- `lane.subagentInspect` takes the lane id plus `requestId`, `runId` and an
  optional `childId` (`@phosphor/shared/subagent-inspect`): pi-subagents' request
  id form, and run ids that stay one argument and are never a flag. The Host
  sends pi only the `/subagents-inspect-rpc` prompt it builds from them, and only
  while pi lists that command as an extension's, so the text never reaches a
  model; otherwise it is refused `unsupported`. It answers `null`. The view
  arrives as the lane's `subagent-inspect` widget, which every viewer's stream
  carries. As a call it carries no fence, so polling a run never takes control
  of the lane, as a `prompt` op would.

`HOST_LIMITS` caps inbound frames at 8 MiB, outbound frames at 16 MiB,
subscriptions at 64 per socket, pending commands and in-flight calls at 32 per
socket, and receipt interest at 64 ids. Excess commands are rejected without
submission; excess calls close 4429. The oldest status interest is dropped first.
Execution receipts fan out only to interested sockets of the originating client;
attempt replies are socket-local and conflicts leave the original interest intact.
Lane-summary and lane-stream subscriptions require `sessions.read`; terminal
subscriptions independently require `terminal`. Losing either capability on
renewal ends only its corresponding subscriptions. Regaining it permits new
subscriptions. Each call requires its operation's capability before execution and
before delivery; an outstanding result is suppressed if that required capability
is lost or the socket closes. Replay,
queues, UI keys and receipt retention are bounded too. Oversize subscriptions
end with `too-large`, not a closed socket; oversize call results answer
`too-large`. Replay stops when an oversized event becomes a reset snapshot or the
subscription fails; older events never follow the reset. A slow subscription
resumes with one reset snapshot.

If only the settled history cannot fit a live lane snapshot after image elision, the Host
sends `messages: []` and `messagesUnavailable: true`. This optional boolean is absent on
ordinary snapshots; true means “history not delivered”, not “no messages”. The cursor,
state, pending turn and UI remain valid; events continue at the next sequence number.
Readers that predate the flag ignore it. A `too-large` refusal from an older Host is not a
pi exit and does not establish a lane event subscription.

A stopped `lane.messages` call, including one backing `lane.read --part messages`,
returns all messages in the active session context or refuses `too-large`. The chat preview's
source-byte, message-count and frame budgets never silently move the first page forward.
Images can still be elided in place. The Host call keeps its generic refusal text,
`the lane query could not complete`. The `lane.read` op advises trying the running
lane or requesting a narrower part such as `summary`.

| Close code | Meaning                                                                               |
| ---------- | ------------------------------------------------------------------------------------- |
| 1001       | Host stopping                                                                         |
| 4400       | Malformed or oversize frame; binary frame after auth                                  |
| 1009       | Transport rejects an oversize frame; the Host may log 1006 for that close             |
| 4401       | Auth missing, invalid, expired or not yet valid; idle client                          |
| 4403       | Wrong authority, revoked grant or renewal identity change                             |
| 4409       | Unsupported protocol version                                                          |
| 4429       | Too many calls, connections or queued bytes; HTTP 429 during an upgrade is equivalent |

`@phosphor/shared/host-protocol-testing` exports the asynchronous bounded
loopback transport, fake Host and reusable conformance suite. Production
sources cannot import it; a boundary test enforces this rule. Crypto is
injected into the fake, and the tests verify real Ed25519 proofs.

## Lane snapshot transfer

Hosts supporting **Move to…** announce `laneTransfer: true` in `ready`.
Older Hosts remain usable; moving to or from one asks the user to update it.
`host-protocol-lane-transfer.ts` owns the bounded bundle schema, and
`host-protocol-lane-transfer-calls.ts` owns these feature calls:

- `laneTransfer.inspect { laneId }`: source facts or blocker sentences.
- `laneTransfer.export { laneId }` → `{ exportId }`; poll `exportStatus` for the
  bundle's size/hash, `read { exportId, offset }` for base64 chunks, then `release`.
- `laneTransfer.check { repositoryId, source, branchPrefix, sameMachine }`: target
  plan or blockers, without writing a lane.
- `laneTransfer.begin { repositoryId, size, sha256, branchPrefix, sameMachine,
notice, marks }` → `{ importId }`; ordered `chunk { importId, offset, data }`
  fills it; `commit { importId }` starts admission; poll `importStatus` for a new
  lane id or blockers.

Both halves require `sessions.control`: the export includes raw pi and Claude
ledgers and attached files, not only a viewer's rendered messages. Calls carry
opaque 128-bit transfer ids, never caller-chosen filesystem destinations. The
Host selects every destination from its configured repository. Part paths are
relative, bounded, without dot segments, absolute paths or symlinks. Bundles and
every part have SHA-256 checks. Chunks are at most 1 MiB decoded, bundles 256 MiB,
with at most 4,000 parts. Staging is private, expires after an hour, and is cleared
on restart. Completed exports retaining bytes still count against the four-export
cap; imports admit at most two unfinished uploads. Imports commit one at a time.

This explicitly transfers session files across the wire. Desktop uses a private
temporary bundle, also when relaying Host-to-Host; a browser page relays between
Hosts through its memory only. Control and the two Hosts never relay directly to
each other. Raw transcripts are not part of normal lane
subscriptions. An uncertain commit result is unconfirmed and never retried
automatically. The source is never modified and no prompt is replayed.

## File bytes

Hosts that serve raw file bytes announce `fileBytes: true` in `ready`.
`files.readBytes { laneId | repositoryId, path, offset, length }` answers
`{ size, version, data }`: base64 of the `min(length, size - offset)` bytes from
`offset`, under `workspaces.read` and the same path checks as `files.read`
(`libs/shared/src/host-protocol-file-bytes.ts`). A chunk is at most 1 MiB decoded
and a file at most 1 GiB; a larger file is `too-large`, an offset past the end is
`bad-request`. Calls are independent: no transfer id, no Host state. `version` is
an opaque hash of the file's identity, size and change times, so a client reading
many chunks refuses a file that changed under it, and a short chunk is refused
as torn.

## PR status by number

Hosts that read PRs by number announce `prStatus: true` in `ready`. Both calls
need `workspaces.read`, like `github.prs`, and run on the Host's own `gh`
(`libs/shared/src/host-protocol-pr-status.ts`):

- `github.prSummaries {refs, options?}` answers a `GhPrRead`: summaries by PR key
  and each ref's coverage. `refs` holds 1 to 20 distinct exact refs
  (`{host, owner, repo, number}`); `options` is `{force?}`.
- `github.prDetail {ref, options?}` answers one `GhPrDetail` (threads, checks with
  workflow and annotations, reviewers who only commented, activity) or `null` when
  there is none.

Any other key is `bad-request`. Clients parse both answers
(`libs/shared/src/host-protocol-pr-results.ts`): every field bounded, only the PRs
asked for, the PR link https without credentials, and a check or thread link that
is not one dropped. Desktop and the browser reach them through `gh:prSummaries`
and `gh:prDetail` with a third `machine` argument, `host:<hostId>`
(`libs/host-client/src/pr-status-reads.ts`). A Host without the marker is never
called and reads as unavailable, so its lanes keep their checkout branch's PR.

`LaneSummary.pullRequests` carries the PRs a lane's session file points at, in
`LanePrSignals` form: `opened`, `branches`, `reviewing`, `reviewingHere`,
`mentioned`, `pinned` and `hidden`. It is absent while unread, when the lane points
at none, and from older Hosts. A lanes frame carries every lane's signals, so the
wire keeps fewer than the fold (`LANE_PR_WIRE_LIMITS`): the first 20 opened and 20
branches, 10 reviewing, 10 reviewed numbers and 10 mentioned, and the latest 20 pins
and 20 hides. Branches pass the same guard as a lane's branch. The parser drops
invalid signals without refusing the summary; older clients ignore the field.

## Lane pins and markers

A Host keeps each lane's pin and marker, so every client shows the same ones.
`lane.marks {pinned?, marker?}` is a lane command (`laneId` on the frame) with at
least one of the two fields and no other keys. `marker` is a glyph, `''` for an
explicit "no marker", or `null` to forget the choice so the lane falls back to its
derived auto marker; an absent field keeps its current value. A glyph is at most
32 UTF-16 units (the picker's longest emoji is 14), with no control characters,
line or paragraph separators, or unpaired surrogates
(`libs/shared/src/host-protocol-lane-marks.ts`). The op is unfenced: it needs
`sessions.control` but not control of the lane, and it works on a stopped lane.
An unknown lane is `unknown-lane`; older Hosts answer `unsupported`, which clients
show as "update the Host".

`LaneSummary` carries the result as additive optional fields: `pinned: true`
(omitted when not pinned) and `marker` (omitted when there is no explicit choice;
`''` is an explicit none). The parser keeps each only when valid and drops an
invalid one without refusing the summary; older clients rebuild summaries from
known keys and ignore both.

Desktop and the browser send it through `hosts:setLaneMarks(hostId, laneId,
{pinned?, marker?})` over the shared `libs/host-client/src/lane-marks.ts`. Desktop
kept Host-lane pins and markers in its own prefs under each lane's Host resource
key before Hosts kept them; once per Host per app run, when that Host is `ready`
with `laneMarks`, Desktop sends those legacy entries for lanes the Host lists with
no marks yet, then removes them locally. A lane the Host already marked keeps the
Host's marks.

## Lane receipt call

`lane.receipt {laneId}` is a read-only call under the existing `sessions.read`
capability. It does not change hello, the capability list or protocol version.
It returns a bounded `LaneReceipt` from `libs/shared/src/lane-receipt.ts`: title,
repository/branch labels, `settledAt`, duration, file/line counts, tests, artifacts,
excerpt and `done`/`error` outcome. It summarizes a settled run, not the prompt
currently in flight, and works for live and stopped admitted lanes. No caller
supplies a transcript path. Older Hosts can answer `unsupported`; the connection
stays usable and Desktop keeps the plain notice.

This is a run summary, not a durable command receipt or execution acknowledgement.
[Lane notices](chat.md#lane-notices) own the meaning of each displayed fact;
[Desktop enrichment](remote-desktop.md#attention-receipt-enrichment) owns freshness,
outcome matching and timeout behavior. Legacy Claude marker recognition is shared
with Desktop through `libs/shared/src/external-tool-marker.ts`.

## Machine model defaults

`machine.models` (under `skills.read`) answers `{models, source, defaults?}`.
Desktop and browser send `{partial: true}` only if the Host advertised
`partialModels: true` on this connection's `ready` frame. Older Hosts receive
`{}` on the first and only call; older clients ignore the additive boolean.
Without the opt-in the Host returns a complete pi list within the call budget
or fails. With it, a failed probe or a cold probe taking over 1.5 s can answer
with `source: config`. This projection populates a cold picker, but does not
replace a complete list. The client retries with backoff in either case.

A successful pi answer with no models is complete; the picker offers sign-in.
Both shells re-read the models and provider readiness after Host sign-in, setup
or a settings write, on reconnect and on focus (throttled), including when
the last list was healthy. No skills read is required.

The additive `defaults {model?: {provider, id}, thinkingLevel?}` is the Host pi's
own new-session default ([host.md](host.md#machine-features)), so a client reads
it without `machine.configure`; nothing else from the Host's settings crosses.
It needs no `ready` marker: it rides an answer clients already read, so an older
Host omits it and an older client ignores it. Clients parse it strictly
(`libs/shared/src/host-protocol-machine/model-defaults.ts`: only those keys, ids
bounded as a catalogue model's, a known thinking level) and drop a malformed one
without losing the catalogue. When a refresh omits `defaults`, clients retain the
last known defaults for that connection, including those from a settings save. Desktop and the browser receive it through
`hosts:models` (`libs/host-client/src/machine-reads.ts`), and a new Host lane
starts on it when it is usable
([lane creation](remote-desktop.md#machine-context-and-lane-creation)).

## Web Push

A Host that pushes lane attention to closed browsers announces the additive
`webPushKey` in `ready`: its VAPID public key, an uncompressed P-256 point as 87
characters of unpadded base64url. Clients drop a malformed key
(`isP256PublicKey`) and project it as `HostConnectionView.webPushKey`; older
clients ignore it. Both calls need `sessions.read`, like reading the lanes the
pushes announce, and act only for the calling client, which the Host takes from
the connection's grant, never from params
(`libs/shared/src/host-protocol-web-push.ts`):

- `notifications.subscribe {endpoint, keys: {p256dh, auth}}` registers this
  client's push subscription, replacing its previous one. `endpoint` is https on
  `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `web.push.apple.com`
  or a `*.notify.windows.com` subdomain, with no credentials, port or fragment, at
  most 2048 characters; `p256dh` is a P-256 point on the curve and `auth` 16 bytes.
  A Host keeps at most 20 and forgets the least recently registered beyond that.
- `notifications.unsubscribe {endpoint}` forgets this client's subscription with
  that endpoint; another client's is never touched.

Any other key, endpoint or key material is `bad-request`; a revoked client, or a
Host that does not know its current owner, is `forbidden`. Both answer `null`. A client calls them only on a Host that announces the key
(`libs/host-client/src/web-push.ts`, confirmed only on the connection that
answered).

A push body is one JSON object, at most 3072 bytes, encrypted to the device as one
aes128gcm record (RFC 8291) under a VAPID ES256 token (RFC 8292):
`{v: 1, hostId, laneId, kind, machine, title, receipt?}`. `kind` is `finished`,
`needs-input` or `failed`; `machine` and `title` are bounded labels; `receipt`
holds only the run's facts (outcome, duration, files changed, tests,
artifacts), never the reply excerpt, repository, branch or paths. The device
refuses any other key. Requests carry a 6-hour `TTL`, `Urgency: high` for
needs-input and a per-lane `Topic`, so a newer push replaces an undelivered older
one. [Web client](web-client.md#web-push) owns how a browser registers and shows them.

## Host grants

`libs/shared/src/host-grant.ts` defines
`phosphor-grant.v1.<payload>.<signature>`, with canonical unpadded base64url
parts. This is not a JWT: the algorithm is always Ed25519, with no header.
Parsing is not signature verification. Signing and verification belong to
the apps, not the shared contract.

A grant names a control origin, key id, owner, login session, Host, enrollment
epoch, client id and label, capabilities, issue and expiry times and a unique
id. It carries no lane contents, repository names or paths. The Host verifies
the signature against a bounded control keyset and checks issuer, Host, owner,
epoch, a lifetime of at most 300 seconds, clock skew and revoked sessions or
clients. A renewal cannot change the owner or client identity. Effective
capabilities are the intersection of grant and Host capabilities. Seeing an
enrolled machine is never a grant to execute on it.

Machine configuration is a separate, explicit grant request (`configure: true`).
Control signs an optional `configure: true` claim rather than adding a new name
to every grant's legacy `caps` array: older Hosts reject unknown capability names
but safely ignore additive claims. A supporting Host intersects that signed
opt-in with its own `machine.configure` feature. Without the opt-in, ready frames
omit the new name from both capability arrays and advertise support through the
additive `settings` boolean instead, preserving older Desktop parsers. Renewal
reports effective capabilities in an optional `auth-renewed.capabilities` array;
losing configuration authority removes it immediately. Desktop requests this
privilege separately from normal lane access and forgets the request on sign-out.

The additive `machineShell` boolean in `ready` says the Host accepts a lane-less
`terminal.create`, a shell in its home folder ([terminal.md](terminal.md#machine-shells)).
Older clients ignore it; older Hosts omit it, and clients then refuse locally
rather than send an op the Host would forbid.

The additive `laneMarks` boolean in `ready` says the Host keeps lane pins and
markers ([Lane pins and markers](#lane-pins-and-markers)). Clients project it as
`HostConnectionView.laneMarks`.

The additive `prStatus` boolean in `ready` says the Host reads PRs by number and
sends lane PR signals ([PR status by number](#pr-status-by-number)). Clients
project it as `HostConnectionView.prStatus`.

The additive `prTracking` boolean in `ready` says the Host refreshes a lane after
a `/` prompt that succeeded, so a Track or Hide (`/phosphor-prs`, which appends
to the lane's file without a pi event) reaches the lane's summary
`pullRequests`. Clients project it as `HostConnectionView.prTracking` and refuse
Track and Hide on a Host without it: host-v0.2.80 announces `prStatus` but not
this, and a write there would never show.

The additive `laneArchive` boolean in `ready` says the Host accepts `lane.archive`,
`archive.restore`, `archive.purge` and the `archive.list` call
([Lane archives](host.md#lane-archives)). Clients project it as
`HostConnectionView.laneArchive`. Without it, clients disable Archive and send
none of these; they never fall back to `lane.delete`.

### Machine-origin grants

A grant may carry `origin: 'machine'` and `machine`, the calling machine's enrolled
Host id. Control signs it when one enrolled machine asks for a grant to a sibling
([Control plane](control-plane.md#machine-reach)). The parser requires both claims
together, `caps: []` and no `configure`; any other mix fails with `machine`.
`grantPrincipal` names it a `machine` principal, and `sameGrantIdentity` refuses a
renewal that changes owner, client, origin or machine. A Host checks it only with
`machineOrigin: true` in its expectations; otherwise `checkGrantClaims` answers
`machine-origin`. An older Host drops both claims and reads a grant with no caps,
which admits nothing.

A Host puts `machineOrigin: true` in its expectations while two things hold: it
has opted in (it serves ops and its policy lets other machines in), and the last
heartbeat that carried control's `machineReach` did not turn it off; a beat that
leaves `machineReach` out is no news (`apps/host/src/api/authority.ts`). Its
heartbeat reports its own side as `machineGrants`. A Host binds the opt-in to its ops dispatcher and `machineOps` policy. Dropping the opt-in, or a
beat that turns reach off, closes every machine-origin socket and no other; a
beat that revokes the grant's session or client closes it like any grant. At most
16 machine-origin sockets are open at once (`AUTHORITY_LIMITS.machineConnections`);
the next first authentication gets `4429 machine-connections`.

A machine connection's ready frame announces no capabilities. It may send only
`ops.run`, as a call or a command, `receipt-status` for its own client, and
`ping`. Every other frame is refused before the lane adapter: a subscription
`subscribe-failed forbidden`, any other command a rejected `forbidden` receipt,
any other call a `forbidden` error and terminal input a refused ack, so no
controller or fence moves. An `ops.run` naming a catalog op marked `surfaceOnly`
(confirm answers, policy, undo) is refused in band, before the dispatcher, as
`{status: 'denied', code: 'forbidden'}`: the call's `result` and the command's
`done` receipt carry it (`apps/host/src/api/machine-adapter.ts`). The
dispatcher judges a `machine` principal as another machine's agent whatever the
request's `actor` says (`libs/session-runtime/src/ops/principals.ts`).

### Machine configuration operations

`machine.settings.read`, `machine.settings.patch` and `machine.settings.check`
require `machine.configure`. Their schemas and reviewed response projection live
in `libs/shared/src/machine-settings*.ts`. Sections are providers, connectors,
agent defaults, resources and advanced. Folder scope names an admitted 16-hex
repository id, never a caller path. Patches name an allowlisted change and the
current SHA-256 revision; they preserve unrelated settings. A lost reply is
uncertain, not a reason to replay the mutation automatically.

Agent reads advertise additive `agentBehaviorSupported: true` before clients offer
compaction/retry, thinking-visibility and message-delivery edits. Older Hosts
remain readable and show an upgrade explanation for those controls. Agent patches
allow only reviewed bounded fields, preserve unknown nested settings, and never
materialize inherited machine defaults into a folder. Agent reads also advertise
additive `agentClearSupported: true`: `null` for an allowlisted key or nested
compaction/retry field then clears it, and the Host deletes the key rather than
writing `null`, so a folder inherits again. Host policy keys stay machine-only,
`null` included. Older Hosts refuse `null`, so clients offer clearing only when the
flag is present. Resource responses may
include reviewed package content counts and a resource-filter indicator; older
responses without these fields remain valid.

Connector reads carry each server's name, scope, transport, enabled state and
exposure, never its URL, command, headers or environment. Two fields are additive:
`oauth` (pi signs in to the server with MCP OAuth, as `mcpUsesOAuth` in
`libs/shared/src/mcp.ts` decides) and `overridden: true` (the folder's file
overrides a global server). Older Hosts leave both out; clients then offer Sign in
on every https connector.

Resource reads also carry additive `webAccess { configured, exists, malformed }`:
the names of the pi-web-access provider keys set in the Host's `web-search.json`
(`WEB_ACCESS_KEYS`, `libs/shared/src/web-access.ts`), never their values. The
`resources` change `webAccess.key { key, value | null }` sets one allowlisted key
to one bounded line of text, or deletes it; it is machine-wide (no
`repositoryId`) and preserves every other key. The `resources` revision hashes
pi's `settings.json` files and `web-search.json`, and both the snapshot and the
commit check that same revision. Older Hosts omit `webAccess` and refuse the
change. Advanced reads carry additive `pi { version?, path, agentDir }`: the
version the Host checked at start, where that pi is installed and its agent
folder. Older Hosts omit it.

Configuration calls serialize through a bounded eight-entry service queue.
File commits recheck the current revision and live authority immediately before
an atomic rename. Losing configuration authority advances an admission epoch;
regranting it cannot revive an old asynchronous write or spawn. These are
process-local locks and checks, not a cross-process filesystem transaction.

`skills.install {bundle, overwrite?}` also requires `machine.configure`. It copies
one validated skill bundle (`libs/shared/src/host-protocol-skill-share.ts`) into
the Host's global skills folder; the client reads it with `skills.export {name}`
under `skills.read` ([host.md](host.md#machine-features)).

`machine.task` selects a reviewed fixed-purpose program, not arbitrary argv,
executable paths or environment. `host.update` runs the Host's own installed
release updater and takes no other field ([host.md](host.md#updating)); an
older Host rejects it as `bad-request`. `provider.logout {name}` runs
`pi auth logout <name>` for one provider id (lowercase letters, digits, `.`,
`_` and `-`, never an option); an older Host rejects it as `bad-request` too. It and settings-originated `provider.login`
require configuration, terminal and session-control capabilities. The latter
carries `configure: true`; legacy provider sign-in retains its existing grants.
Claude account selection uses a known account id or `addAccount: true`.
Configuration PTYs remain owner-private and check authority for input, output,
subscription and resize. These configuration PTY programs are stopped on their
admitted authorization loss or disconnect and are bounded to fifteen minutes. Killing a program is
best-effort; already-applied effects are not rolled back.

`claude.account` is a lane command, not an unfenced machine operation. It requires
configuration plus session control, the controller's current fence, a verified
Claude target and a saved Claude transcript. Stop, bind and resume recheck live
authority. It never takes another client's control, sends an automatic prompt,
or silently falls back to the former account after failure.

The Host remembers each revoked session and client id for 15 minutes after the
last heartbeat that named it, at most 1000 of each
(`apps/host/src/api/authority.ts`). A repeated id only refreshes its time, and a
clock step backwards never shortens it. A live revocation is never evicted to make
room. If a heartbeat's new ids do not fit, the Host closes instead: open streams
close with 4403 and upgrades answer 503. It stays closed for at least 15 minutes
after the last heartbeat that did not fit. Missing heartbeats, missing fields and
expiring ids never reopen it. After that, only a heartbeat that carries owner,
epoch and revocations, and fits, reopens it. A removed Host stays closed.

Recovery therefore costs at least 15 minutes of refused connections and waits for
a complete heartbeat. A backwards clock step makes the wait longer. The Host
accepts this cost so that it keeps no unbounded state and no per-grant
bookkeeping. [Control's per-owner caps](control-plane.md#grants-and-revocation)
keep an honest account well below 1000 live ids, so the cap is only reached in
exceptional cases.

## Agent ops

`libs/shared/src/host-protocol-ops.ts` defines `ops.run`, the one wire for every
agent-control catalog op ([Agent control](agent-control.md)). A read is a `call`
with `method: 'ops.run'` and an `OpsRunRequest` as params. A write is a laneless,
unfenced `command` whose op is `{type: 'ops.run', ...OpsRunRequest}`; target lanes
travel in `args`. `LaneOp` gains only this member, and `HOST_CALL_METHODS` and
`CAPABILITY_FOR` are unchanged.

The request is `{op, args, reason?, actor?, confirm?, batch?, page?}` with exact
keys. `op` is one to three dot-separated camelCase words, at most 64 characters.
`actor: {kind: 'agent', lane?, title?}` is attribution and only ever a downgrade.
The first submission of an asked op answers `{status: 'confirm', confirmId, digest,
title, message, items, expiresAt}` and runs nothing; the run submission carries
`confirm: {confirmId, digest}`. A batch the origin fans out to several Hosts names
each share as `batch: {id, index, size}`. `OpsRunResult` is `ok`, `confirm` or
`denied`. Refusals the dispatcher decides travel in band as `{status: 'denied',
code, text}` on both paths; frame-level refusal stays for malformed frames. An op
that may outlast the Host's answer deadline answers `ok` with `data: {jobId}`.

`OPS_LIMITS`: the `args` JSON is at most 300 KiB, a content argument inside it at
most 256 KiB, a command result and tool text 64 KiB, a call's `data` 1 MiB, a reason
300 characters, 200 ids per op, 20 Hosts per batch reached four at a time, and a
confirmation lives ten minutes.

`ready` announces the related UI with additive booleans (`READY_OP_FLAGS`): `ops`,
`ownerLocal`, `laneEditing`, `laneContext`, `laneReload`, `sandboxes`,
`folderDirectives`, `configFiles` and `pagedLanes`. Each is absent, true or false;
any other value refuses the frame. A lane summary may carry `pause: {reason:
'service-update', at}`; an invalid pause is dropped, never the summary.

Older readers stay safe. A previous-release client drops the flags and the pause.
A previous-release Host answers an `ops.run` command `unsupported`, and the call
too. With a dispatcher bound, a Host announces `ops` and serves both forms through the ops adapter. Clients gate catalog traffic on `ready.ops`, not the release version. A service flag is derived from its catalog handlers (`apps/host/src/ops/binding.ts`).
`libs/shared/src/base-684cb3478.compatibility.test.ts` runs every new frame
through frozen copies of the previous release's parsers.

The optional boolean `ready.warmOnOpen` is a machine policy, not a grant. A Host running
with its local-mode marker advertises it on both listeners; a headless Host omits it.
True permits a client with lane control authority to warm the opened stopped lane. A claim
uses `control.take` with `ifUnheld: true`, never a takeover. Absent or false disables warm-up.

Clients project the flags as `HostConnectionView` booleans, false when absent so a
reconnect to an older Host forgets them (`libs/host-client/src/ready-view.ts`).
`ownerLocal` is projected only on a connection created with `local: true`, this
machine's own socket; a connection created with `lanes: false` skips the
automatic `lanes` subscription. `opsRun` (`libs/host-client/src/ops.ts`) sends a
read as the call and a write as the command; the caller chooses by the op's
catalog tier. It reads an older Host's `unsupported`, a rejected receipt or a
call error, as `{status: 'denied', code: 'unsupported'}` with text telling the
user to update that machine, and throws on any other failure without resending.

## Paged lanes

`folder.list` and `lane.list` can page catalog results. `libs/shared/src/host-protocol-paged-lanes.ts` defines page shapes and `ready.pagedLanes` is a catalog capability. It does **not** lift the `lanes` topic’s limit of 64 folders and 1,000 lanes or merge pages into that projection. See [future features](future-features.md#service-follow-ups).

## The local socket

`libs/shared/src/host-local.ts` is the contract for a machine's local daemon. A
client on the machine connects over a Unix socket. It fetches a single-use nonce
from `GET /v1/hello` on that socket. It then sends the unchanged `auth` frame
with a local credential:
`phosphor-local.v1.<base64url(payload)>.<base64url(signature) | "">`. The
payload names `kind: 'owner' | 'local'`, the machine id, the client, the 64-hex
nonce and `iat`. An owner credential is signed with a key whose public half
`setup --local` wrote to `owner-clients.json`. A local one is unsigned and may
name its lane (`PI_SESSION_ID`), as attribution only. The TCP listener refuses
this prefix and the socket refuses `phosphor-grant.`.

Desktop's grant port returns `localGrantIssueResponse`: `host.id` is the
machine id from `local-identity.json`, `host.endpoint` is
`phosphor-local:<machineId>`, and `host.publicKey` is the raw Ed25519 key
`local-identity.json` carries.

`localSocketCandidates` lists, in order: on Linux `$XDG_RUNTIME_DIR/phosphor-host/phosphor.sock`,
then `<state>/run/phosphor.sock`, then `/tmp/phosphor-<uid>/<hash>.sock`.
`chooseLocalSocket` takes the first within 103 UTF-8 bytes. The path is
measured before binding: Node 22 silently truncates a longer path, and Node 24
throws. The listener requires an owner-private 0700 directory and a 0600 socket; it refuses an Origin header. A leftover socket is removed only after a refused connection, not on arbitrary probe errors. `local.json` in the state directory advertises the running listener. In standby the socket serves owner calls only; clients reconnect when lanes start. `HOST_SIDECARS` names the daemon's files, and `OWNER_LOCK_FILE` is the
owner lock in pi's agent folder.

## Owner calls

`libs/shared/src/host-protocol-owner.ts` lists `OWNER_METHODS`. These are `call`
methods served only on the local socket, ahead of the lane adapter, so they work in
standby. Only the attested owner reaches them, except `machine.local`,
`machine.identity.reload` and `headroom.status`, which any socket principal
may call. Mutations are idempotent by their key (`migrationId`, `leaseId`,
`accountId`, `action`). Long work answers at once and is observed through
`machine.local`. No token lands in a receipt.

- Machine: `machine.local` (`LocalStatus`; fields after `mode` are owner-only),
  `machine.identity.reload`, `machine.enroll` (refused in standby), `machine.owner`
  (acquire leaves standby; release refuses while any lane has a live pi, otherwise durably writes standby, replies, then drains with exit 75 for a supervised restart; release in standby does nothing), `machine.pause` (service update), `app.service.register`,
  `headroom.status` and `headroom.set`.
- Migration: `owner.index` (paged lane rows), `owner.migrate.begin|import|status|commit|abort`.
  Import sections are folders, policy, accounts, lanes, marks, archives, artifacts
  and routines. They carry Desktop-minted lane UUIDs, so Desktop can re-key drafts.
  Each lane carries its title, branch, model, `createdAt` and `updatedAt`.
  Archives carry new daemon manifests: a lane UUID `id` and `metadata.repositoryId`,
  with the Desktop record's paths and identities kept byte-equal. Account folders
  live in the account root the section names. Bindings name known accounts.
  Unread marks import as `attention = read + 1`. Routine workspaces are realpaths.
- Leases: `owner.lease.take|renew|release` over absolute folder paths.
- `owner.transcript.page` is a reserved contract without a daemon handler.
- `app.service.register {service: 'brain', endpoint, token, recall}` registers the Desktop
  bridge for this owner connection only. `endpoint` is an absolute Unix socket path (no
  `..` segments or NUL; at most 103 UTF-8 bytes), never a TCP address. This call returns
  `{registered: true}`; the token is neither logged nor written to a receipt.
- `owner.account.prepare|register|discard` are reserved; an unbound owner method returns `unsupported`.

Parity exemptions belong only to the attested owner: no per-lane terminal cap, terminal input throttle or hourly attachment quota, and no answer deadline for `bash` or `compact`. Their receipts settle when pi answers, the operation fails, or the owner connection closes. The 32-terminal machine limit remains. Neither a user grant nor a machine grant gets an exemption.

`OWNER_LIMITS` defines a 120 s owner-call budget separately from `HOST_LIMITS`. Clients send owner calls with `ownerCall`
(`libs/host-client/src/owner.ts`), which checks params before sending and throws
`OwnerCallError` with the daemon's code. It still rides the connection's 30 s call
deadline, so a call that runs longer reads as `internal` until the local binding
gives owner calls their own deadline.

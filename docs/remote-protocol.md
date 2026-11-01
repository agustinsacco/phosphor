# Host protocol

The shared wire contract is `libs/shared/src/host-protocol.ts`; grants are in
`libs/shared/src/host-grant.ts`. [Remote access](remote-access.md) explains the flow;
[Host API](host.md#api) owns listener admission and [Desktop](remote-desktop.md) owns
connection recovery. Control is never in the lane data path.

`libs/shared/src/remote-host.ts` validates hello compatibility and enrolled Host
identity and builds Host-qualified resource keys. Hello parsing alone is not
authentication; trusting a connection also requires the enrolled key proof.

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
unknown; a later completion cannot replace it or send another terminal receipt.

The pi commands a controller may send are `LANE_PI_OPS`: prompt, steer,
follow-up, abort, abort-retry, model, thinking level, compact, session name,
`clear_queue`, the steering and follow-up modes, auto-compaction, auto-retry,
`bash` and `abort_bash`. The client (`laneOperation` in `libs/host-client`) and
the Host (`toPiCommand`) list the same set; anything else is refused
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
materialize inherited machine defaults into a folder. Resource responses may
include reviewed package content counts and a resource-filter indicator; older
responses without these fields remain valid.

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
older Host rejects it as `bad-request`. It and settings-originated `provider.login`
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

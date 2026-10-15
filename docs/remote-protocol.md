# Host protocol

The shared wire contract is `libs/shared/src/host-protocol.ts`; grants are in
`libs/shared/src/host-grant.ts`. [Remote access](remote-access.md) explains the flow;
[Host API](host.md#api) owns listener admission and [Desktop](remote-desktop.md) owns
connection recovery. Control is never in the lane data path.

`libs/shared/src/remote-host.ts` validates hello compatibility and enrolled Host
identity and builds Host-qualified resource keys. Hello parsing alone is not
authentication; trusting a connection also requires the enrolled key proof.

## Frames and streams

`libs/shared/src/host-protocol.ts` defines protocol v1, its allowlist, parsers
and limits. The Host serves hello and grant authentication on `/v1/hello`
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
`result` are read-only. `command`, `receipt` and `receipt-status` handle
mutations. The persisted control fence rises on takeover or release. Only the
controller can mutate a lane with its current fence. The first mutation of an
unowned lane acquires control and raises the fence before pi events. Every
viewer sees control changes at the same stream position. Disconnecting does
not release control.
A request id deduplicates one action. Receipts are pending, done, failed,
rejected or unknown. Unknown means the outcome is uncertain, not permission to
repeat the action with a new id. A pi command unanswered after 30 seconds becomes
unknown; a later completion cannot replace it or send another terminal receipt.

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

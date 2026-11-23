# Agent control

A lane's `phosphor` tool, the Host CLI and Settings use one catalog, not three sets of commands. The process that owns the target applies its policy. Asking from a lane, from a terminal, from another machine and from the app are distinct principals; writing a lane or machine ID in an argument does not give the caller its authority.

## Catalog

Use `phosphor help` for domains, `phosphor help lane` for operations and `phosphor help lane.read` for arguments. Help works offline. Write `domain verb` or `domain.verb`; `lanes`, `archives`, `hosts`, `artifacts` and `changes` are aliases. For example:

```sh
phosphor lanes --json
phosphor artifact list --host bee1,bee2
```

In the tool, pass the words **after** `phosphor` as an array, not a shell command: `{"args":["swarm","on"],"reason":"Review the two implementations independently"}`. `--` ends flag parsing; booleans accept `on`, `off`, `true`, `false`; arrays accept repeated flags or comma-separated values. Follow a `next` cursor with `--page`. A tool can pass `content` separately (256 KiB UTF-8, within the 300 KiB argument budget).

`@phosphor/shared/ops-catalog` owns names, schemas, tier, scope, timing, routing and the explicit gaps. A Host serves ops once its lanes bind the dispatcher. In-app Desktop serves a subset: for example, it can read, rename and pin lanes and change its own policy, but cannot create a lane through the tool or forward `--host`. Desktop routes `ops:run` to the selected Host, including its own service in daemon mode. The browser uses only the selected Host when it announces `ready.ops`; older Hosts still serve lanes. See [Agent ops on the wire](remote-protocol.md#agent-ops).

Results distinguish **now**, **next request**, **after this run** and **new lanes**. For example, an agent's model change waits for settlement. On the service `lane.reload` can continue after settlement if the turn ended on the tool result and no service pause intervenes. Background operations answer **Started** with a job ID; use `job.status` or `job.list` for the caller's jobs. Use the app, not a daemon op, for Move to… or sharing a skill between machines. `mcp.check` reads cached status; use Settings → Connectors for a live check or to remove or retarget an OAuth connector. Config writes expose reviewed behavior fields, not trust or credentials.

## Policy and confirmations

Open **Settings → Agent** on the machine you want to configure. `agentControl` governs local agents and the CLI; `machineOps` governs other machines. Each can allow changes, allow reads only, or turn access off. Local Brain service requests do not depend on the agent-control switch. Desktop keeps the in-app policy in preferences; the daemon checks `<state>/agent-policy.json` against its last write. An outside change can tighten but cannot relax that snapshot; Settings reports the discrepancy.

The dispatcher checks the resolved op's availability, principal, lane and policy. Agents and machine callers need a reason for a change. Confirmation cannot override a never-tier or user-only operation, a user opt-out, or a failed admission check. Default limits are 120 ops/minute per caller, ten created lanes per ten minutes and lineage depth two. Destructive ops ask by default; tier rules can only tighten. An op override cannot waive approval for a destructive change to another lane or a write into its folder. Reading another lane's files does not ask by default.

An ask runs nothing on that target. Review the owner-generated summary, exact targets, controller where applicable, and the separately labelled agent reason. An interactive agent asks in its lane; an unattended routine returns `unattended` instead of waiting. **Pending approvals** lists CLI and machine asks. Only a surface approves; the creator redeems an approved ID and digest once for the same arguments. Pending confirmations expire in ten minutes or on owner restart.

The audit is local and user-writable, not a tamper-proof log (`state.sqlite` on the service, `agent-ops.sqlite` in Desktop userData in-app). Retention is 10,000 rows / 90 days. The argument summary is capped at 2 KiB; prompt, content and instructions can retain a 200-character preview and hash. **Undo** needs a safe recorded inverse and a still-current value. Phosphor does not keep old skill or routine content for Undo. Undoing folder creation removes its listing, not its files.

## The op channel

The owner marks a spawn with `PHOSPHOR_OPS=v1` and supplies the tool and skill when agent control is enabled. Children do not load the tool. In a marked session `PiRpcClient` intercepts an `editor` request titled `phosphor-op/v1` before the ordinary dialog path. The owner derives identity from the lane and answers that editor ID; absent owner, malformed input, Stop and deadline expiry return failures instead of leaving pi waiting. `lane.liveness` reports live sub-agent work internally; it is not a catalog command. See [bundled extensions](extensions.md#bundled-extensions-phosphors-own).

## From a terminal

Fixed [Host commands](host.md) such as `status`, `setup` and `update` keep their meanings. Catalog argv goes over the local Unix socket as `local`, **not** as the attested Desktop owner. `PI_SESSION_ID` cannot grant agent privileges: use the lane tool for a self-scoped request. There is no TCP fallback or TTY approval. For an ask the CLI prints the summary and waits for Pending approvals. `--json` writes the result to stdout. For catalog requests exit **0** means success, **1** refusal or failure, and **75** approval expiry. On a headless Host without the socket, use its lane tool or target it with `--host` from a local service.

## Machines

`phosphor hosts` shows state and why a sibling isn't ready. For routable ops, `--host` accepts an exact name (case-insensitive), ID prefix (at least eight hex digits), comma list or `all` (every **other** machine). Ambiguous names list candidates. Naming this machine alone runs here; mixing it with siblings is refused.

The daemon reads the signed directory (30-second cache) and gets a short-lived machine grant per target. The connections carry ops, not lane subscriptions. A lost read can retry once; writes are never resent after connection loss. An unconfirmed write needs checking on the target before trying again.

A multi-machine change is **not atomic**. Targets that allow it can finish immediately. When others ask, the origin collects their exact selections in one confirmation. After approval it redeems each asking target's own confirmation once; it does not repeat successful or unanswered changes. See [machine reach and trust](remote-access.md).

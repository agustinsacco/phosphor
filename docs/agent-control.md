# Agent control

Agents in a lane can drive what Phosphor's UI does, through one catalog of ops,
on this machine and on the owner's other machines. This page is the contract's
home. Its sections fill in as the pieces land. Today only the shared contracts
exist; no lane, Host or Desktop serves an op yet.

## Contracts

- The wire: `ops.run` ([Host protocol](remote-protocol.md#agent-ops)), paged lane
  lists ([Paged lanes](remote-protocol.md#paged-lanes)).
- Catalog types: `libs/shared/src/ops/types.ts` (`OpSpec`, tiers, scopes, classes
  and when an op applies).
- The op channel: `libs/shared/src/ops/channel.ts`. The lane's `phosphor` tool sends
  an RPC `editor` request titled `phosphor-op/v1`. Its prefill is an
  `OpRequestEnvelope`, or the internal `lane.liveness` message. The owner answers
  every request id with an `OpReplyEnvelope`. When nothing listens, the RPC
  client answers `{status: 'unsupported', code: 'no-owner'}` at once.
- Policy and audit: `libs/shared/src/ops/policy.ts` (`AgentPolicy`, the audit
  row, `ConfirmInfo`).
- Surfaces: one IPC channel, `ops:run` (`libs/shared/src/ipc/ops.ts`), runs a
  catalog op as the user on This Mac (`local`) or a Host (`remote`). Audit,
  policy, confirmations and undo are catalog ops on it, not channels of their own.
  `onOpsChanged` pushes a change signal (`ops:changed`); listeners reload through
  `ops:run`. The browser serves only `ops:run`. Desktop and the browser answer
  every `ops:run` `{status: 'denied', code: 'unsupported'}` until a binding serves
  ops. Before migration, Desktop keeps the policy in `AppPrefs.agentPolicy`.
- Owners: `libs/session-runtime/src/ops/types.ts` names the four principals
  (`surface`, `agent`, `machine`, `local`), `OpHandler`, the per-owner
  `OpsBinding` (handlers, gaps, ready flags, policy and audit stores, lanes,
  deferred work, `--host`, Brain) and the `OpsDispatcher` interface.
  `libs/session-runtime/src/ops/reach.ts` is the caller-side port for other
  machines (`Reach`).
- Clients: `opsRun` and `ownerCall` in `libs/host-client`
  ([Host protocol](remote-protocol.md#agent-ops)).

## Catalog

## Policy and confirmations

## The op channel

## Machines

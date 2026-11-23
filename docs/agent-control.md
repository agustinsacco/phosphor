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

## Catalog

## Policy and confirmations

## The op channel

## Machines

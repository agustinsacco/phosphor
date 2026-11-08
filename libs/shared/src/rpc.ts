/**
 * pi RPC protocol types, mirrored from the installed
 * @earendil-works/pi-coding-agent (re-verified against 1.2.0):
 *   dist/modes/rpc/rpc-mode.js  (the command switch — the real command list)
 *   dist/modes/rpc/rpc-types.d.ts
 *   docs/rpc.md
 *
 * Self-contained on purpose — Phosphor spawns pi as a subprocess and never
 * imports its code. Public fixtures and leaf tests pin this local mirror;
 * compiler mutation tests exercise both key-agreement guards.
 *
 * Note on the drift guards below: they prove the command
 * union and `RpcResponseDataMap` agree with *each other*. They cannot see pi,
 * so a command pi supports but Phosphor never declared stays invisible to them —
 * that is how `get_available_thinking_levels` went missing. When re-verifying
 * against a new pi, diff this facade and its leaves against pi's command switch, not just
 * against itself.
 *
 * The stdout event shape is NOT the internal `AgentSessionEvent`: the wire
 * passes through pi's `toJsonEvent` (dist/modes/json-event.js), which strips
 * the cumulative snapshots. Concretely, across 0.84.0 → 0.84.4:
 *   0.84.0  dropped `message` from `message_update` and
 *           `assistantMessageEvent.partial` — assemble the partial yourself
 *   0.84.2  re-added cumulative `usage` on `message_update`
 *   0.84.3  put tool-call id + name on `toolcall_start` directly (the
 *           supported replacement for reading them off `partial`)
 *   0.84.4  added the `clear_queue` command
 *   0.99.0  added `data.disposition` to `prompt` / `steer` / `follow_up`, and
 *           nested tool calls (`parentToolCallId`) from tools such as codemode
 *   1.1.0   added `aborted` to `agent_settled` and `durationMs` to
 *           `tool_execution_end` and to tool results
 * The delta fields below are optional because a minimum-version install may
 * predate 0.84.2/0.84.3; every reader must tolerate their absence.
 */

import type { RpcCommandType } from './rpc/commands'
import type { RpcResponseDataMap } from './rpc/responses'
import type { AssertNever } from './rpc/key-guards'

export type * from './rpc/messages'
export type * from './rpc/events'
export type * from './rpc/commands'
export type * from './rpc/responses'
export type * from './rpc/extension-ui'

/**
 * `RpcResponseDataMap` is maintained by hand alongside the `RpcCommand` union.
 * These assertions fail to compile if the two ever drift — a missing key or a
 * stale leftover — instead of surfacing as an `undefined` payload at runtime.
 */
export type _NoMissingResponseKeys = AssertNever<Exclude<RpcCommandType, keyof RpcResponseDataMap>>
export type _NoExtraResponseKeys = AssertNever<Exclude<keyof RpcResponseDataMap, RpcCommandType>>

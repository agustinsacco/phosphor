import type { RpcCommandType, RpcResponseDataMap } from '../../rpc'
import type { AssertNever } from '../key-guards'

type MissingKey = Exclude<RpcCommandType, keyof Omit<RpcResponseDataMap, 'abort'>>
type ExtraKey = Exclude<keyof (RpcResponseDataMap & { stale_command: undefined }), RpcCommandType>

// These must consume TS2344; an unused directive is a CI typecheck failure.
// @ts-expect-error A command without its response entry violates the production constraint.
export type MissingResponse = AssertNever<MissingKey>

// @ts-expect-error A stale response entry violates the same production constraint.
export type ExtraResponse = AssertNever<ExtraKey>

import { Type, type TProperties, type TObject } from 'typebox'
import { OPS_LIMITS } from '../../host-protocol-ops'
import { record, utf8Length } from '../../host-protocol/primitives'
import type { LegacyHostCapability } from '../../remote-host'
import { kebab } from '../aliases'

import type { OpArgs, OpContext, OpSpec } from '../types'

export type CatalogSpec = OpSpec<OpArgs, TObject>
type Options = Omit<CatalogSpec, 'name' | 'summary' | 'args' | 'tier' | 'applies' | 'scope'> &
  Partial<Pick<CatalogSpec, 'applies' | 'scope'>>
export const object = <P extends TProperties>(fields: P, constraints = {}) =>
  Type.Object(fields, { ...constraints, additionalProperties: false })
export const optional = Type.Optional
export const text = (maxLength: number) => Type.String({ minLength: 1, maxLength })
export const id = text(256)
export const path = text(4096)
export const ref = path
export const on = Type.Boolean()
export const choice = (...values: string[]) => Type.String({ enum: values })
export const count = (maximum: number, minimum = 1) => Type.Integer({ minimum, maximum })
export const ids = Type.Array(id, { minItems: 1, maxItems: OPS_LIMITS.idsPerOp, uniqueItems: true })
export const content = optional(
  Type.Refine(
    Type.String({ maxLength: OPS_LIMITS.contentBytes }),
    (body) => utf8Length(body) <= OPS_LIMITS.contentBytes,
  ),
)
export const laneScope = (_args: OpArgs, ctx: OpContext) => (ctx.self ? 'self' : 'other-lane')
export const laneOrAsk = (_args: OpArgs, ctx: OpContext) => (ctx.self ? 'lane' : 'destructive')
export const caps = (...caps: LegacyHostCapability[]) => ({ caps })
export const configure = { caps: ['sessions.control'], configure: true } as const
export const control = caps('sessions.control')
export const workspaceWrite = caps('workspaces.write', 'sessions.control')
export const paged = { paged: true } as const
export const untrusted = { untrustedResult: true } as const

/** A binding captures the full args for the inverse (including the target id), or no inverse. */
export const previous =
  (op: string): NonNullable<CatalogSpec['inverse']> =>
  (_args, before) =>
    record(before) ? { op, args: before } : null
export const reverse =
  (op: string): NonNullable<CatalogSpec['inverse']> =>
  (args) => ({ op, args })

/** Domain constructors supply the common scope and surface capability check. */
export function domain(
  scope: CatalogSpec['scope'],
  requires: NonNullable<CatalogSpec['requires']>,
  defaults: Options = {},
) {
  return (
    name: string,
    summary: string,
    tier: CatalogSpec['tier'],
    args: TObject = object({}),
    options: Options = {},
  ): CatalogSpec => ({
    name,
    summary,
    tier,
    scope,
    requires,
    args,
    applies: 'now',
    ...defaults,
    ...options,
  })
}

/** Semantic CLI labels; deliberately separate from the wire validation schema. */
export function argumentLabel(spec: CatalogSpec, key: string): string {
  if (key === 'target' || key === 'lane' || (key === 'ref' && spec.name.startsWith('lane.')))
    return 'lane-ref'
  if (key === 'revision' || key === 'expected' || (key === 'ref' && spec.name.startsWith('git.')))
    return 'revision'
  if (['path', 'from', 'to', 'source', 'directory'].includes(key) && spec.name.startsWith('files.'))
    return 'path'
  if (/path$/i.test(key)) return 'path'
  if (/url$/i.test(key)) return 'url'
  if (/ids?$/i.test(key)) return key.endsWith('s') ? 'id,…' : 'id'
  return kebab(key)
}

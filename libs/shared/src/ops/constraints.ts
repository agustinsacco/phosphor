import { Type, type TSchema } from 'typebox'
import { Check } from 'typebox/value'
import { record } from '../host-protocol/primitives'
import type { CatalogSpec } from './domains/spec'

export function integerRange(schema: TSchema): string | undefined {
  if (!Type.IsInteger(schema)) return undefined
  if (schema.minimum !== undefined && schema.maximum !== undefined)
    return `${schema.minimum}–${schema.maximum}`
  if (schema.minimum !== undefined) return `≥ ${schema.minimum}`
  if (schema.maximum !== undefined) return `≤ ${schema.maximum}`
}

export function choices(schema: TSchema): string | undefined {
  if (Type.IsString(schema) && schema.enum?.length) return schema.enum.join('|')
  if (Type.IsLiteral(schema)) return String(schema.const)
}

export function constraint(schema: TSchema): string {
  const allowed = choices(schema)
  if (allowed !== undefined) return `one of ${allowed}`
  const range = integerRange(schema)
  if (Type.IsInteger(schema)) return range ? `an integer ${range}` : 'an integer'
  if (Type.IsBoolean(schema)) return 'on, off, true or false'
  if (Type.IsString(schema)) {
    const min = schema.minLength ?? 0
    return schema.maxLength !== undefined ? `text of ${min}–${schema.maxLength} characters` : 'text'
  }
  if (Type.IsUnion(schema)) return schema.anyOf.map(constraint).join(' or ')
  if (Type.IsArray(schema)) {
    const count = `${schema.minItems ?? 0}–${schema.maxItems ?? 'any'}`
    return `${count} ${schema.uniqueItems ? 'unique ' : ''}items (${constraint(schema.items)})`
  }
  if (Type.IsNull(schema)) return 'null'
  if (Type.IsObject(schema)) {
    if (schema.minProperties === 1 && schema.maxProperties === 1)
      return `exactly one of ${Object.keys(schema.properties).join(', ')}`
    const required = schema.required?.join(', ')
    return required ? `a JSON object with ${required}` : 'a JSON object with only supported fields'
  }
  return 'a value matching the declared schema'
}

/** Traverse only declared fields. No typebox diagnostic or user-supplied key/value is printed. */
function invalid(schema: TSchema, value: unknown, field: string): string | null {
  if (Check(schema, value)) return null
  if (Type.IsObject(schema) && record(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key))
        return `Missing argument: ${field ? `${field}.` : ''}${key} (expected ${constraint(schema.properties[key]!)}).`
    }
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(value, key)) continue
      const why = invalid(child, value[key], field ? `${field}.${key}` : key)
      if (why) return why
    }
    if (Object.keys(value).some((key) => !Object.hasOwn(schema.properties, key)))
      return `${field || 'arguments'} contains an unsupported field; use ${Object.keys(schema.properties).join(', ') || 'no fields'}.`
  }
  return `${field || 'arguments'}: expected ${constraint(schema)}.`
}

export const validateOpArgs = (spec: CatalogSpec, args: unknown): string | null =>
  invalid(spec.args, args, '')

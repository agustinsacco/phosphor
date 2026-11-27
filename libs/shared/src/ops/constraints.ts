import { Type, type TSchema } from 'typebox'
import { Check } from 'typebox/value'
import { record } from '../host-protocol/primitives'
import type { CatalogSpec } from './domains/spec'

export function integerRange(schema: TSchema): string | undefined {
  if (!Type.IsInteger(schema) || !record(schema)) return undefined
  const { minimum, maximum } = schema
  if (typeof minimum === 'number' && typeof maximum === 'number') return `${minimum}–${maximum}`
  if (typeof minimum === 'number') return `≥ ${minimum}`
  if (typeof maximum === 'number') return `≤ ${maximum}`
}

export function choices(schema: TSchema): string | undefined {
  if (Type.IsString(schema) && record(schema)) {
    const values = schema.enum
    if (Array.isArray(values) && values.length) return values.join('|')
  }
  if (Type.IsLiteral(schema)) return String(schema.const)
}

/** A schema may require exactly one of several single-field selectors. */
function exclusiveFields(options: unknown): string | undefined {
  if (!Array.isArray(options) || options.length < 2) return
  const fields = []
  for (const option of options) {
    if (!record(option) || Object.keys(option).length !== 1) return
    const { required } = option
    if (!Array.isArray(required) || required.length !== 1 || typeof required[0] !== 'string') return
    fields.push(required[0])
  }
  return fields.join(', ')
}

export function constraint(schema: TSchema): string {
  if (Type.IsLiteral(schema)) return String(schema.const)
  const allowed = choices(schema)
  if (allowed !== undefined) return `one of ${allowed}`
  const options = record(schema) ? schema : {}
  const { minLength, maxLength, minItems, maxItems, uniqueItems, minProperties, maxProperties } =
    options
  const range = integerRange(schema)
  if (Type.IsInteger(schema)) return range ? `an integer ${range}` : 'an integer'
  if (Type.IsBoolean(schema)) return 'on, off, true or false'
  if (Type.IsString(schema)) {
    const min = typeof minLength === 'number' ? minLength : 0
    if (typeof maxLength === 'number') return `text of ${min}–${maxLength} characters`
    return min > 0 ? `text of at least ${min} characters` : 'text'
  }
  if (Type.IsUnion(schema)) return schema.anyOf.map(constraint).join(' or ')
  if (Type.IsArray(schema)) {
    const min = typeof minItems === 'number' ? minItems : 0
    const count = typeof maxItems === 'number' ? `${min}–${maxItems}` : `at least ${min}`
    return `${count} ${uniqueItems === true ? 'unique ' : ''}items (${constraint(schema.items)})`
  }
  if (Type.IsNull(schema)) return 'null'
  if (Type.IsObject(schema)) {
    const exclusive = exclusiveFields(options.oneOf)
    if (exclusive) return `exactly one of ${exclusive}`
    if (minProperties === 1 && maxProperties === 1)
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

import { isAbsolute, normalize } from 'node:path'
import { isControlUrl } from '../control/url'
import { passRefusal } from '../machine/environment'
import type { ConfigError } from './schema'

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const LIMITS = { repositories: 64, pass: 64, path: 32 }

export const pointer = (...segments: (string | number)[]): string =>
  segments.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Absolute and already normalized. `~` is never expanded. */
export function isPinnedPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 4096 &&
    !value.includes('\0') &&
    isAbsolute(value) &&
    normalize(value) === value &&
    (value === '/' || !value.endsWith('/'))
  )
}

function fail(errors: ConfigError[], at: string, message: string): void {
  errors.push({ pointer: at, message })
}

export function onlyKeys(
  record: Record<string, unknown>,
  keys: string[],
  at: string[],
  errors: ConfigError[],
): void {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) fail(errors, pointer(...at, key), 'unknown key')
  }
}

export function validatePath(candidate: unknown, at: string, errors: ConfigError[]): void {
  if (!isPinnedPath(candidate)) fail(errors, at, 'must be an absolute, normalized path')
}

function list(
  candidate: unknown,
  max: number,
  at: string,
  noun: string,
  errors: ConfigError[],
): unknown[] | null {
  if (Array.isArray(candidate) && candidate.length <= max) return candidate
  fail(errors, at, `must be a list of up to ${max} ${noun}`)
  return null
}

export function validatePi(pi: unknown, errors: ConfigError[]): void {
  if (!isRecord(pi)) fail(errors, '/pi', 'must be an object with "executable"')
  else {
    onlyKeys(pi, ['node', 'executable'], ['pi'], errors)
    validatePath(pi.executable, '/pi/executable', errors)
    if (pi.node !== undefined) validatePath(pi.node, '/pi/node', errors)
  }
}

export function validateRepositories(candidate: unknown, errors: ConfigError[]): void {
  const repositories = list(candidate, LIMITS.repositories, '/repositories', 'folders', errors)
  repositories?.forEach((repository, index) => {
    if (repository === '/') fail(errors, pointer('repositories', index), 'must not be /')
    else validatePath(repository, pointer('repositories', index), errors)
  })
}

export function validateEnvironment(environment: unknown, errors: ConfigError[]): void {
  if (environment !== undefined && !isRecord(environment))
    fail(errors, '/environment', 'must be an object')
  else if (environment !== undefined) {
    onlyKeys(environment, ['pass', 'path'], ['environment'], errors)
    const pass =
      environment.pass === undefined
        ? []
        : list(environment.pass, LIMITS.pass, '/environment/pass', 'variable names', errors)
    pass?.forEach((name, index) => {
      const at = pointer('environment', 'pass', index)
      if (typeof name !== 'string' || !NAME_PATTERN.test(name))
        fail(errors, at, 'must be a variable name')
      else {
        const refusal = passRefusal(name)
        if (refusal) fail(errors, at, refusal)
      }
    })
    const dirs =
      environment.path === undefined
        ? []
        : list(environment.path, LIMITS.path, '/environment/path', 'folders', errors)
    dirs?.forEach((dir, index) => {
      const at = pointer('environment', 'path', index)
      if (typeof dir === 'string' && dir.includes(':')) fail(errors, at, 'must not contain ":"')
      else validatePath(dir, at, errors)
    })
  }
}

export function validateControl(control: unknown, errors: ConfigError[]): void {
  if (control !== undefined) {
    if (!isRecord(control)) fail(errors, '/control', 'must be an object with url')
    else {
      onlyKeys(control, ['url'], ['control'], errors)
      if (!isControlUrl(control.url))
        fail(errors, '/control/url', 'must be a bare https origin, or http on loopback')
    }
  }
}

export function validateApi(api: unknown, errors: ConfigError[]): void {
  if (api !== undefined) {
    if (!isRecord(api)) fail(errors, '/api', 'must be an object with port')
    else {
      onlyKeys(api, ['port'], ['api'], errors)
      if (
        typeof api.port !== 'number' ||
        !Number.isInteger(api.port) ||
        api.port < 1024 ||
        api.port > 65535
      )
        fail(errors, '/api/port', 'must be an integer from 1024 to 65535')
    }
  }
}

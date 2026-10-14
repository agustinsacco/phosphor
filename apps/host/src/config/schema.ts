import { isAbsolute, normalize } from 'node:path'
import { isValidContextBudgetValue } from '@phosphor/shared/context-budget'
import { isControlUrl } from '../control/url'
import { passRefusal } from '../machine/environment'

/**
 * Host config, version 1. It pins what runs on this machine, so validation
 * refuses unknown keys at any depth, relative or unnormalized paths and
 * names the environment policy forbids, and reports every problem at once.
 * Values of variables never live here: `environment.pass` holds names.
 */
export interface HostConfigV1 {
  version: 1
  /** Defaults to the short hostname, sanitized. */
  hostId?: string
  pi: {
    /** Required when `executable` is a Node script, as an npm-installed pi is. */
    node?: string
    /** What `command -v pi` prints. */
    executable: string
  }
  /** Holds `pi-ext/`. Defaults to the Host bundle's own directory. */
  resourceRoot?: string
  /** Directories sessions may run in: 1 to 64, never `/`. */
  repositories: string[]
  /** Desktop's grammar. '' or absent is the 200k default. */
  contextBudget?: string
  environment?: {
    /** Extra variable names pi receives. */
    pass?: string[]
    /** Extra PATH folders, after node's and before the platform defaults. */
    path?: string[]
  }
  /** Reserved for an account adapter. v1 accepts only null. */
  accounts?: null
  /** Bare control-plane origin. Defaults to DEFAULT_CONTROL_URL. */
  control?: { url: string }
  api?: { port: number }
}

export interface ConfigError {
  /** RFC 6901 pointer into the config; '' is the file as a whole. */
  pointer: string
  message: string
}

export type ConfigValidation =
  { ok: true; config: HostConfigV1 } | { ok: false; errors: ConfigError[] }

/** The HostHello identifier pattern, so a configured id is always presentable. */
export const HOST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const LIMITS = { repositories: 64, pass: 64, path: 32 }
const KEYS = {
  root: [
    'version',
    'hostId',
    'pi',
    'resourceRoot',
    'repositories',
    'contextBudget',
    'environment',
    'accounts',
    'control',
    'api',
  ],
  pi: ['node', 'executable'],
  environment: ['pass', 'path'],
}

export const pointer = (...segments: (string | number)[]): string =>
  segments.map((part) => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')

function isRecord(value: unknown): value is Record<string, unknown> {
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

/** The configured hostId, else the short hostname made presentable. */
export function resolveHostId(config: Pick<HostConfigV1, 'hostId'>, hostname: string): string {
  if (config.hostId) return config.hostId
  const short = hostname.split('.')[0] ?? ''
  const id = short
    .replace(/[^A-Za-z0-9._:-]/g, '-')
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 128)
  return id || 'host'
}

export function validateHostConfig(value: unknown): ConfigValidation {
  if (!isRecord(value))
    return { ok: false, errors: [{ pointer: '', message: 'must be an object' }] }
  const errors: ConfigError[] = []
  const fail = (at: string, message: string) => errors.push({ pointer: at, message })
  const onlyKeys = (record: Record<string, unknown>, keys: string[], at: string[]) => {
    for (const key of Object.keys(record)) {
      if (!keys.includes(key)) fail(pointer(...at, key), 'unknown key')
    }
  }
  const path = (candidate: unknown, at: string) => {
    if (!isPinnedPath(candidate)) fail(at, 'must be an absolute, normalized path')
  }
  const list = (candidate: unknown, max: number, at: string, noun: string): unknown[] | null => {
    if (Array.isArray(candidate) && candidate.length <= max) return candidate
    fail(at, `must be a list of up to ${max} ${noun}`)
    return null
  }

  onlyKeys(value, KEYS.root, [])
  if (value.version !== 1) fail('/version', 'must be 1')
  if (value.hostId !== undefined) {
    if (typeof value.hostId !== 'string' || !HOST_ID_PATTERN.test(value.hostId)) {
      fail(
        '/hostId',
        'must be 1 to 128 letters, digits, ".", "_", ":" or "-", starting alphanumeric',
      )
    }
  }

  if (!isRecord(value.pi)) fail('/pi', 'must be an object with "executable"')
  else {
    onlyKeys(value.pi, KEYS.pi, ['pi'])
    path(value.pi.executable, '/pi/executable')
    if (value.pi.node !== undefined) path(value.pi.node, '/pi/node')
  }
  if (value.resourceRoot !== undefined) path(value.resourceRoot, '/resourceRoot')

  const repositories = list(value.repositories, LIMITS.repositories, '/repositories', 'folders')
  if (repositories?.length === 0) fail('/repositories', 'must list at least one folder')
  repositories?.forEach((repository, index) => {
    if (repository === '/') fail(pointer('repositories', index), 'must not be /')
    else path(repository, pointer('repositories', index))
  })

  const budget = value.contextBudget
  if (budget !== undefined) {
    if (
      typeof budget !== 'string' ||
      (budget.trim() !== '' && !isValidContextBudgetValue(budget))
    ) {
      fail(
        '/contextBudget',
        'must be "" (the 200k default), "auto", "off" or a size such as "400k"',
      )
    }
  }

  const environment = value.environment
  if (environment !== undefined && !isRecord(environment)) fail('/environment', 'must be an object')
  else if (environment !== undefined) {
    onlyKeys(environment, KEYS.environment, ['environment'])
    const pass =
      environment.pass === undefined
        ? []
        : list(environment.pass, LIMITS.pass, '/environment/pass', 'variable names')
    pass?.forEach((name, index) => {
      const at = pointer('environment', 'pass', index)
      if (typeof name !== 'string' || !NAME_PATTERN.test(name)) fail(at, 'must be a variable name')
      else {
        const refusal = passRefusal(name)
        if (refusal) fail(at, refusal)
      }
    })
    const dirs =
      environment.path === undefined
        ? []
        : list(environment.path, LIMITS.path, '/environment/path', 'folders')
    dirs?.forEach((dir, index) => {
      const at = pointer('environment', 'path', index)
      if (typeof dir === 'string' && dir.includes(':')) fail(at, 'must not contain ":"')
      else path(dir, at)
    })
  }

  if (value.control !== undefined) {
    if (!isRecord(value.control)) fail('/control', 'must be an object with url')
    else {
      onlyKeys(value.control, ['url'], ['control'])
      if (!isControlUrl(value.control.url))
        fail('/control/url', 'must be a bare https origin, or http on loopback')
    }
  }

  if (value.api !== undefined) {
    if (!isRecord(value.api)) fail('/api', 'must be an object with port')
    else {
      onlyKeys(value.api, ['port'], ['api'])
      if (
        typeof value.api.port !== 'number' ||
        !Number.isInteger(value.api.port) ||
        value.api.port < 1024 ||
        value.api.port > 65535
      )
        fail('/api/port', 'must be an integer from 1024 to 65535')
    }
  }

  if (value.accounts !== undefined && value.accounts !== null) {
    fail('/accounts', 'must be null: accounts are not available on a Host yet')
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, config: value as unknown as HostConfigV1 }
}

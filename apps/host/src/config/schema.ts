import { isValidContextBudgetValue } from '@phosphor/shared/context-budget'
import {
  isRecord,
  onlyKeys,
  validateApi,
  validateControl,
  validateEnvironment,
  validatePath,
  validatePi,
  validateRepositories,
} from './schema-fields'

export { isPinnedPath, pointer } from './schema-fields'

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
  /** Directories sessions may run in: up to 64, never `/`. */
  repositories: string[]
  /** Desktop's grammar. '' or absent is the 200k default. */
  allowRepositoryChanges?: boolean
  autoNameLanes?: boolean
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
const ROOT_KEYS = [
  'version',
  'hostId',
  'pi',
  'resourceRoot',
  'repositories',
  'contextBudget',
  'autoNameLanes',
  'allowRepositoryChanges',
  'environment',
  'accounts',
  'control',
  'api',
]

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
  onlyKeys(value, ROOT_KEYS, [], errors)
  if (value.version !== 1) errors.push({ pointer: '/version', message: 'must be 1' })
  if (value.hostId !== undefined) {
    if (typeof value.hostId !== 'string' || !HOST_ID_PATTERN.test(value.hostId)) {
      errors.push({
        pointer: '/hostId',
        message: 'must be 1 to 128 letters, digits, ".", "_", ":" or "-", starting alphanumeric',
      })
    }
  }

  validatePi(value.pi, errors)
  if (value.resourceRoot !== undefined) validatePath(value.resourceRoot, '/resourceRoot', errors)
  validateRepositories(value.repositories, errors)

  if (value.autoNameLanes !== undefined && typeof value.autoNameLanes !== 'boolean')
    errors.push({ pointer: '/autoNameLanes', message: 'must be a boolean' })
  if (
    value.allowRepositoryChanges !== undefined &&
    typeof value.allowRepositoryChanges !== 'boolean'
  )
    errors.push({ pointer: '/allowRepositoryChanges', message: 'must be a boolean' })
  const budget = value.contextBudget
  if (budget !== undefined) {
    if (
      typeof budget !== 'string' ||
      (budget.trim() !== '' && !isValidContextBudgetValue(budget))
    ) {
      errors.push({
        pointer: '/contextBudget',
        message: 'must be "" (the 200k default), "auto", "off" or a size such as "400k"',
      })
    }
  }

  validateEnvironment(value.environment, errors)
  validateControl(value.control, errors)
  validateApi(value.api, errors)

  if (value.accounts !== undefined && value.accounts !== null) {
    errors.push({
      pointer: '/accounts',
      message: 'must be null: accounts are not available on a Host yet',
    })
  }
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, config: value as unknown as HostConfigV1 }
}

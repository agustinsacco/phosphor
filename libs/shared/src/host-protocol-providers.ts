import { terminalKeys, terminalRecord } from './host-protocol-terminals'

export const PROVIDER_LOGIN_LIMITS = { perHost: 2, disconnectMs: 10 * 60 * 1000 } as const
export interface ProviderLoginOp {
  type: 'provider.login'
  provider: string
}
/** Syntax only. Membership is checked against the Host's own inspected providers. */
export function parseProviderLoginOp(value: unknown): ProviderLoginOp | null {
  return terminalRecord(value) &&
    terminalKeys(value, ['type', 'provider']) &&
    value.type === 'provider.login' &&
    typeof value.provider === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(value.provider)
    ? { type: value.type, provider: value.provider }
    : null
}

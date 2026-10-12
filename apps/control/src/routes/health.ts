import type { HealthResponse } from '@phosphor/shared/control-api'
export function health(configured: boolean, version: string): HealthResponse {
  return { ok: true, version, configured }
}

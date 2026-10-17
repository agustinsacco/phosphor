import { log } from '../debug-log'
import { trafficLog } from './traffic-log'

/** Main's file log for remote access, mirrored into the memory-only traffic log. */
export function tappedLog(scope: string, message: string, data?: unknown): void {
  log(scope, message, data)
  trafficLog.observe(scope, message, data)
}

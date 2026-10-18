import {
  runPrintMode as runPortablePrintMode,
  type PrintModeOptions,
} from '@phosphor/session-runtime/pi/print-mode'

export { OWN_GROUP, killProcessTree } from '@phosphor/session-runtime/pi/print-mode'
export type { PrintModeOptions }

/** Keep Desktop's established result shape; transport failure categories are Host-local. */
export interface PrintModeResult {
  stdout: string
  error?: string
}

export async function runPrintMode(
  binaryPath: string,
  args: string[],
  options: PrintModeOptions,
): Promise<PrintModeResult> {
  const result = await runPortablePrintMode(binaryPath, args, options)
  return {
    stdout: result.stdout,
    ...(result.error !== undefined ? { error: result.error } : {}),
  }
}

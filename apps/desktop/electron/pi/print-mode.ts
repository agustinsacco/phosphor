import {
  runPrintMode as runPortablePrintMode,
  type PrintModeOptions,
} from '@phosphor/session-runtime/pi/print-mode'
import { assertInAppRuntime } from '../local-machine/mode'

// The frozen packages.characterization.test.ts mocks these through './print-mode'.
export { killProcessTree } from '@phosphor/session-runtime/pi/print-mode'
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
  // Never rejects, as before: in daemon mode the refusal is the run's error.
  try {
    assertInAppRuntime('run pi in print mode')
  } catch (error) {
    return { stdout: '', error: error instanceof Error ? error.message : String(error) }
  }
  const result = await runPortablePrintMode(binaryPath, args, options)
  return {
    stdout: result.stdout,
    ...(result.error !== undefined ? { error: result.error } : {}),
  }
}

import { createRequire as createTerminalRequire } from 'node:module'

export interface HostPty {
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (data: string) => void): { dispose(): void }
  onExit(listener: (event: { exitCode: number }) => void): { dispose(): void }
}
export interface HostPtyModule {
  spawn(
    shell: string,
    args: string[],
    options: {
      cwd: string
      cols: number
      rows: number
      name: string
      env: Record<string, string>
    },
  ): HostPty
}
function isHostPtyModule(value: unknown): value is HostPtyModule {
  return (
    typeof value === 'object' &&
    value !== null &&
    'spawn' in value &&
    typeof value.spawn === 'function'
  )
}
/** No module-name lookup or caller-supplied path. Missing native resources disable terminals. */
export function loadHostPty(): HostPtyModule | null {
  try {
    const value: unknown = createTerminalRequire(import.meta.url)('./native/node-pty/lib/index.js')
    return isHostPtyModule(value) ? value : null
  } catch {
    return null
  }
}

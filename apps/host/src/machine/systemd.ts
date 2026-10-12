import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { IdentityFailure } from '../control/identity'
import { probe } from './probe'

export const HOST_UNIT = 'phosphor-host.service'
const safe = (value: string, max: number) =>
  value.length <= max && !/[\p{Cc}\u2028\u2029]/u.test(value)
function quote(value: string, exec = false, max = 65536) {
  if (!safe(value, max))
    throw new IdentityFailure('Service paths and PATH must not contain control characters.')
  return `"${value
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"')
    .replaceAll('%', '%%')
    .replaceAll('$', () => (exec ? '$$' : '$'))}"`
}
export function serviceUnit(node: string, bundle: string, config: string, path: string): string {
  if (![node, bundle, config].every(isAbsolute))
    throw new IdentityFailure('Service paths must be absolute.')
  return `[Unit]\nDescription=Phosphor Host\n\n[Service]\nType=simple\nExecStart=${[node, bundle, 'run', '--config', config].map((value) => quote(value, true)).join(' ')}\nEnvironment=${quote(`PATH=${path}`, false, 65541)}\nRestart=on-failure\nRestartSec=10\nRestartPreventExitStatus=64 69 77 78\n\n[Install]\nWantedBy=default.target\n`
}
export async function writeServiceUnit(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.phosphor-unit-${randomUUID()}.tmp`)
  try {
    const file = await open(temp, 'wx', 0o644)
    try {
      await file.chmod(0o644)
      await file.writeFile(text)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, path)
  } finally {
    await unlink(temp).catch((error: unknown) => {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    })
  }
}
export async function removeServiceUnit(path: string) {
  await unlink(path).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
  })
}
export interface ServiceResult {
  code: number | null
  stdout: string
}
export type ServiceRunner = (
  file: string,
  args: readonly string[],
  stream?: boolean,
) => Promise<ServiceResult>

/** Non-streamed results are bounded by the existing probe. Follow never buffers output. */
export function serviceRunner(
  env: NodeJS.ProcessEnv,
  print: (text: string) => void,
  signal?: AbortSignal,
): ServiceRunner {
  const environment: Record<string, string> = {}
  for (const [name, value] of Object.entries(env))
    if (value !== undefined) environment[name] = value
  return async (file, args, stream) => {
    if (!stream) {
      const result = await probe(file, args, { env: environment, secrets: [], timeoutMs: 10_000 })
      return {
        code: result.timedOut || result.truncated || result.error ? null : result.code,
        stdout: result.stdout,
      }
    }
    return new Promise((resolve) => {
      const child = spawn(file, args, { env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
      const abort = () => {
        child.kill('SIGKILL')
      }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      child.stdout?.on('data', (chunk: Buffer) => print(chunk.toString('utf8')))
      child.stderr?.on('data', (chunk: Buffer) => print(chunk.toString('utf8')))
      child.on('error', () => {
        signal?.removeEventListener('abort', abort)
        resolve({ code: null, stdout: '' })
      })
      child.on('close', (code) => {
        signal?.removeEventListener('abort', abort)
        resolve({ code, stdout: '' })
      })
    })
  }
}

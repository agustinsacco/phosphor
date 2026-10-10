import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { errorText } from '@phosphor/shared/errors'
import { validateHostConfig, type ConfigError, type HostConfigV1 } from './schema'

export const CONFIG_MAX_BYTES = 64 * 1024

/**
 * `--config FILE` wins. Otherwise the XDG location, on Linux and macOS
 * alike. There is deliberately no environment variable naming the file.
 */
export function defaultConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and is ignored.
  const xdg = env.XDG_CONFIG_HOME
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.config')
  return join(base, 'phosphor-host', 'config.json')
}

export type ConfigLoad =
  | { ok: true; path: string; config: HostConfigV1 }
  | { ok: false; path: string; errors: ConfigError[] }

/**
 * Read and validate the config. Every failure here is a config problem.
 * The file pins which executables run, so it, its directory, and (through
 * a symlink) the real file's directory must belong to the user running the
 * Host and must not be writable by anyone else.
 */
export async function loadHostConfig(
  path: string,
  /** The user running the Host: `process.getuid()`, undefined where there is none. */
  uid: number | undefined,
): Promise<ConfigLoad> {
  const file = resolve(path)
  const failed = (...messages: string[]): ConfigLoad => ({
    ok: false,
    path: file,
    errors: messages.map((message) => ({ pointer: '', message })),
  })
  if (uid === undefined) return failed('the Host runs on Linux and macOS')

  let real: string
  try {
    real = await realpath(file)
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT'
    return failed(missing ? `no config file at ${file}` : errorText(error))
  }
  try {
    const problems: string[] = []
    for (const target of new Set([dirname(file), dirname(real), real])) {
      const info = await stat(target)
      if (info.uid !== uid) {
        problems.push(`${target} belongs to uid ${info.uid}, not to you (${uid})`)
      } else if (info.mode & 0o022) {
        problems.push(`${target} is writable by others: run chmod go-w ${target}`)
      }
    }
    if (problems.length > 0) return failed(...problems)
    const info = await stat(real)
    if (!info.isFile()) return failed(`${file} is not a file`)
    if (info.size > CONFIG_MAX_BYTES) return failed(`${file} is larger than 64 KiB`)
    return parse(file, await readFile(real, 'utf8'))
  } catch (error) {
    return failed(errorText(error))
  }
}

function parse(file: string, text: string): ConfigLoad {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    // V8 quotes the text around a bad token. Keep only the position, so a
    // value pasted into the config by mistake is never echoed back.
    const at = /at position \d+(?: \(line \d+ column \d+\))?/.exec(errorText(error))?.[0]
    return {
      ok: false,
      path: file,
      errors: [{ pointer: '', message: `not valid JSON${at ? ` ${at}` : ''}` }],
    }
  }
  const result = validateHostConfig(parsed)
  return result.ok
    ? { ok: true, path: file, config: result.config }
    : { ok: false, path: file, errors: result.errors }
}

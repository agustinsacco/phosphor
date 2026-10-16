import { createRequire as createBuiltinRequire } from 'node:module'
import type { DatabaseSync } from 'node:sqlite'

// Only a builtin is loaded, so the executable is a valid base in both ESM and CJS bundles.
const requireBuiltin = createBuiltinRequire(process.execPath)

/** Load on first use without hiding unrelated Node warnings. Restore even on load failure. */
export function loadRoutineSqlite(
  load: () => { DatabaseSync: typeof DatabaseSync } = () => requireBuiltin('node:sqlite'),
): { DatabaseSync: typeof DatabaseSync } {
  const original = process.emitWarning
  process.emitWarning = (warning, ...args) => {
    const type =
      warning instanceof Error
        ? warning.name
        : typeof args[0] === 'string'
          ? args[0]
          : typeof args[0] === 'object'
            ? args[0]?.type
            : undefined
    const message = warning instanceof Error ? warning.message : warning
    if (
      type === 'ExperimentalWarning' &&
      message === 'SQLite is an experimental feature and might change at any time'
    )
      return
    Reflect.apply(original, process, [warning, ...args])
  }
  try {
    return load()
  } finally {
    process.emitWarning = original
  }
}

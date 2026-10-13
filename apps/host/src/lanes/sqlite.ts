import type { DatabaseSync } from 'node:sqlite'

let importGate = Promise.resolve()

/** Suppress only Node's SQLite experimental warning, during the lazy import. */
export async function loadSqlite(
  load: () => Promise<{ DatabaseSync: typeof DatabaseSync }> = () => import('node:sqlite'),
): Promise<{ DatabaseSync: typeof DatabaseSync }> {
  const previous = importGate
  let release = () => {}
  importGate = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
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
    if (type === 'ExperimentalWarning' && /SQLite/.test(message)) return
    Reflect.apply(original, process, [warning, ...args])
  }
  try {
    return await load()
  } finally {
    process.emitWarning = original
    release()
  }
}

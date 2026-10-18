import { posix } from 'node:path'

const aliases = [
  ['@phosphor/session-runtime/', 'libs/session-runtime/src/'],
  ['@phosphor/pi-extensions/', 'libs/pi-extensions/pi-ext/'],
  ['@phosphor/shared/', 'libs/shared/src/'],
  ['@shared/', 'libs/shared/src/'],
  ['@/', 'apps/desktop/src/'],
]
export const compareCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function resolveImport(file, specifier, files) {
  const bare = specifier.split(/[?#]/)[0]
  const alias = aliases.find(([prefix]) => bare.startsWith(prefix))
  const path = alias
    ? alias[1] + bare.slice(alias[0].length)
    : bare.startsWith('.')
      ? posix.normalize(posix.join(posix.dirname(file), bare))
      : undefined
  if (!path) return undefined
  const base = path.replace(/\.[cm]?jsx?$/, '')
  return [
    path,
    ...['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'].flatMap((extension) => [
      base + extension,
      `${path}/index${extension}`,
    ]),
  ].find((candidate) => files.has(candidate))
}

export function newSpecifier(file, target, original) {
  const suffix = original.match(/[?#].*$/)?.[0] ?? ''
  const bare = original.slice(0, original.length - suffix.length)
  const alias = aliases.find(([prefix, root]) => bare.startsWith(prefix) && target.startsWith(root))
  let relative = alias
    ? alias[0] + target.slice(alias[1].length)
    : posix.relative(posix.dirname(file), target)
  if (!alias && !relative.startsWith('.')) relative = `./${relative}`
  // A dotted basename (a.test) is not an explicit source extension (a.test.ts).
  if (/\.[cm]?js$/.test(bare)) relative = relative.replace(/\.[cm]?tsx?$/, posix.extname(bare))
  else if (!bare.endsWith(posix.extname(target))) relative = relative.replace(/\.[cm]?[jt]sx?$/, '')
  if (relative.endsWith('/index') && !bare.endsWith('/index')) relative = relative.slice(0, -6)
  return relative + suffix
}

function movedSubtrees(files, moved) {
  const directories = new Set()
  for (const from of moved.keys()) {
    let directory = posix.dirname(from)
    while (directory !== '.') {
      directories.add(directory)
      directory = posix.dirname(directory)
    }
  }
  const result = new Map()
  for (const directory of directories) {
    const descendants = files.filter((file) => file.startsWith(`${directory}/`))
    const first = descendants[0]
    const suffix = first.slice(directory.length)
    const destination = moved.get(first)?.slice(0, -suffix.length)
    // Mixed directories and parents with inconsistent mappings are not moved subtrees.
    if (
      destination &&
      descendants.every((file) => moved.get(file) === destination + file.slice(directory.length))
    )
      result.set(directory, destination)
  }
  return result
}

function affectedPaths(files, moves) {
  const destinations = new Map(moves.map(({ from, to }) => [from, to]))
  const subtrees = movedSubtrees(files, destinations)
  const tracked = new Set(files)
  return (file, text) => {
    const resolved = resolveImport(file, text, tracked)
    if (resolved) {
      const to = destinations.get(file) ?? file
      const target = destinations.get(resolved) ?? resolved
      if (file === to && resolved === target) return false
      return newSpecifier(to, target, text) !== text
    }
    const bare = text.split(/[?#]/)[0].replace(/\/$/, '')
    if (!bare || bare.startsWith('/')) return false
    if (destinations.has(bare) || subtrees.has(bare)) return true
    const relative = posix.normalize(posix.join(posix.dirname(file), bare))
    const target = destinations.get(relative) ?? subtrees.get(relative)
    if (!target) return false
    const to = destinations.get(file) ?? file
    return posix.normalize(posix.join(posix.dirname(to), bare)) !== target
  }
}

function lineReports(file, content, affected, movedPaths) {
  const documentation = /\.md$/i.test(file)
  return content
    .toString('utf8')
    .split('\n')
    .flatMap((text, index) => {
      const links = documentation ? [...text.matchAll(/`([^`]+)`|\]\(([^)]+)\)/g)] : []
      if (
        movedPaths.some((from) => text.includes(from)) ||
        links.some((match) => affected(file, match[1] ?? match[2])) ||
        (!documentation && /!.*\.test\.ts/.test(text))
      )
        return [
          {
            file,
            line: index + 1,
            reason: documentation ? 'doc-path' : 'config-path',
            text: text.trim(),
          },
        ]
      return []
    })
}

export function pathReports(files, contents, records, moves) {
  const reports = []
  const moved = new Set(moves.map(({ from }) => from))
  const movedPaths = [...moved]
  const affected = affectedPaths(files, moves)
  for (const file of files) {
    if (/\.(?:jsonl|svg|png|webp|lock)$/.test(file)) continue
    const record = records.get(file)
    if (record) {
      const positions = new Set(record.imports.map(({ start }) => start))
      for (const entry of record.strings) {
        if (positions.has(entry.start)) continue
        if (
          /(?:!.*|adhoc-sign-mac)\.test\.ts/.test(entry.text) ||
          affected(file, entry.text) ||
          movedPaths.some((from) => entry.text.includes(from))
        )
          reports.push({ file, line: entry.line, reason: 'string-path', text: entry.text })
      }
      if (moved.has(file))
        for (const entry of record.math) reports.push({ file, ...entry, reason: 'path-math' })
    } else reports.push(...lineReports(file, contents.get(file), affected, movedPaths))
  }
  return reports
}

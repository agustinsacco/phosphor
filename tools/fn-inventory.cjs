// Inventory of file sizes and function/method/component sizes across the repo.
// Usage: node fn-inventory.cjs <repoRoot> <outJson>
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
const out = process.argv[3]
const ts = require(path.join(root, 'node_modules/typescript'))

const ROOTS = ['apps/desktop/electron', 'apps/desktop/src', 'apps/desktop/e2e', 'apps/desktop/scripts',
  'apps/host/src', 'apps/host/scripts', 'apps/control/src', 'apps/control/scripts', 'apps/site/src',
  'libs/shared/src', 'libs/session-runtime/src', 'libs/pi-extensions', 'tools/scripts', 'tools/host-release']
const EXT = /\.(ts|tsx|mts|cts|mjs|cjs|js)$/
const SKIP = /node_modules|\/out\/|\/dist\/|\.d\.ts$/

function walk(dir, acc) {
  if (!fs.existsSync(dir)) return acc
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (SKIP.test(p)) continue
    if (e.isDirectory()) walk(p, acc)
    else if (EXT.test(e.name)) acc.push(p)
  }
  return acc
}

function nameOf(node, sf) {
  if (node.name && node.name.getText) return node.name.getText(sf)
  const p = node.parent
  if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf)
  if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf)
  if (p && ts.isCallExpression(p)) {
    const callee = p.expression.getText(sf).slice(0, 40)
    const firstArg = p.arguments[0]
    const label = firstArg && ts.isStringLiteralLike(firstArg) ? firstArg.text.slice(0, 50) : ''
    return `${callee}(${label ? JSON.stringify(label) : ''}…)`
  }
  if (p && ts.isExportAssignment(p)) return 'default'
  return '<anonymous>'
}

const files = []
const fns = []
for (const r of ROOTS) {
  for (const abs of walk(path.join(root, r), [])) {
    const rel = path.relative(root, abs)
    const text = fs.readFileSync(abs, 'utf8')
    const lines = text.split('\n')
    const nonBlank = lines.filter((l) => l.trim()).length
    const isTest = /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel)
    files.push({ file: rel, lines: lines.length, nonBlank, isTest })
    const kind = rel.endsWith('x') ? ts.ScriptKind.TSX : rel.endsWith('.js') || rel.endsWith('.cjs') || rel.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, kind)
    const visit = (node, depth) => {
      const isFn = ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessor(node) || ts.isSetAccessor(node)
      if (isFn && node.body) {
        const start = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const end = sf.getLineAndCharacterOfPosition(node.end).line + 1
        const len = end - start + 1
        // Ignore test-framework callbacks (describe/it/test bodies) for function budgets.
        const n = nameOf(node, sf)
        const testCb = /^(describe|it|test|beforeEach|afterEach|beforeAll|afterAll|test\.describe|test\.step|test\.beforeEach|test\.afterEach)\b/.test(n)
        if (len >= 60 && !testCb) fns.push({ file: rel, name: n, start, end, lines: len, depth, isTest })
      }
      ts.forEachChild(node, (c) => visit(c, depth + (isFn ? 1 : 0)))
    }
    visit(sf, 0)
  }
}
fs.writeFileSync(out, JSON.stringify({ files, fns }, null, 1))
const src = files.filter((f) => !f.isTest)
const tst = files.filter((f) => f.isTest)
console.log(`files=${files.length} src=${src.length} tests=${tst.length}`)
console.log(`src>400=${src.filter((f) => f.lines > 400).length} src>500=${src.filter((f) => f.lines > 500).length} tests>800=${tst.filter((f) => f.lines > 800).length}`)
const srcFns = fns.filter((f) => !f.isTest)
console.log(`src fns>=60=${srcFns.length} >=80=${srcFns.filter((f) => f.lines >= 80).length} >=120=${srcFns.filter((f) => f.lines >= 120).length} >=200=${srcFns.filter((f) => f.lines >= 200).length}`)

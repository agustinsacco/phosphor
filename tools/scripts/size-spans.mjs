import ts from 'typescript'

export const LIMITS = Object.freeze({ file400: 400, function80: 80, 'test-file800': 800 })

export function isTestFile(file) {
  return (
    /(?:^|\/)(?:__tests__|test|tests|e2e)\//.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
  )
}

function propertyName(node, source) {
  if (!node) return ''
  if (ts.isComputedPropertyName(node)) return propertyName(node.expression, source)
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node))
    return node.text
  return node.getText(source).replace(/\s+/g, ' ')
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text]
  return name.elements.flatMap((entry) =>
    ts.isBindingElement(entry) ? bindingNames(entry.name) : [],
  )
}

function isScope(node) {
  return (
    ts.isSourceFile(node) ||
    ts.isBlock(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassLike(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isForInStatement(node)
  )
}

function importedKind(declaration, name) {
  const module = declaration.moduleSpecifier.text
  if (['vitest', '@jest/globals', 'node:test'].includes(module)) {
    if (name === 'describe' || name === 'suite') return 'suite'
    if (name === '*') return 'namespace'
  }
  if (module === '@playwright/test' && name === 'test') return 'playwright'
  return 'local'
}

// Resolve registration names lexically: a local describe or a shadowed import is not a waiver.
function collectBindings(source) {
  const scopes = new Map()
  function visit(node, scope) {
    if (isScope(node)) {
      scope = node
      scopes.set(scope, new Map())
    }
    let bindingScope = scope
    if (
      ts.isVariableDeclaration(node) &&
      ts.isVariableDeclarationList(node.parent) &&
      !(node.parent.flags & ts.NodeFlags.BlockScoped)
    ) {
      while (!ts.isFunctionLike(bindingScope) && !ts.isSourceFile(bindingScope)) {
        bindingScope = bindingScope.parent
        while (!scopes.has(bindingScope)) bindingScope = bindingScope.parent
      }
    }
    const add = (name, kind = 'local') =>
      bindingNames(name).forEach((key) => scopes.get(bindingScope).set(key, kind))
    if (ts.isVariableDeclaration(node) || ts.isParameter(node)) add(node.name)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      let outer = node.parent
      while (outer && !scopes.has(outer)) outer = outer.parent
      scopes.get(outer)?.set(node.name.text, 'local')
    }
    if (
      (ts.isFunctionLike(node) || ts.isClassLike(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      add(node.name)
    if (ts.isImportDeclaration(node) && node.importClause) {
      const clause = node.importClause
      if (clause.name) add(clause.name)
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) add(named.name, importedKind(node, '*'))
      if (named && ts.isNamedImports(named)) {
        for (const entry of named.elements)
          add(entry.name, importedKind(node, (entry.propertyName ?? entry.name).text))
      }
    }
    ts.forEachChild(node, (child) => visit(child, scope))
  }
  visit(source, source)
  return scopes
}

const modifiers = new Set([
  'only',
  'skip',
  'todo',
  'concurrent',
  'sequential',
  'each',
  'skipIf',
  'runIf',
  'serial',
  'parallel',
])

function registrationPath(expression) {
  if (ts.isIdentifier(expression)) return [expression.text]
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = registrationPath(expression.expression)
    return parent && [...parent, expression.name.text]
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ['each', 'skipIf', 'runIf'].includes(expression.expression.name.text)
  )
    return registrationPath(expression.expression)
  return null
}

function isSuiteContainer(node, scopes) {
  const call = node.parent
  if (!ts.isCallExpression(call) || call.arguments.length < 2 || call.arguments.at(-1) !== node)
    return false
  const path = registrationPath(call.expression)
  if (!path) return false
  const [root, ...members] = path
  let kind
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (scopes.get(parent)?.has(root)) {
      kind = scopes.get(parent).get(root)
      break
    }
  }
  kind ??= root === 'describe' || root === 'suite' ? 'suite' : 'local'
  if (kind === 'namespace') {
    if (!['describe', 'suite'].includes(members.shift())) return false
  } else if (kind === 'playwright') {
    if (members.shift() !== 'describe') return false
  } else if (kind !== 'suite') return false
  return members.every((member) => modifiers.has(member))
}

function functionLabel(node, source) {
  if (ts.isConstructorDeclaration(node)) return 'constructor'
  if (node.name) return propertyName(node.name, source)
  let callbackName
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (
      ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isJsxAttribute(parent)
    )
      return propertyName(parent.name, source)
    if (ts.isCallExpression(parent)) {
      const expression = parent.expression
      if (ts.isIdentifier(expression)) callbackName ??= expression.text
      if (ts.isPropertyAccessExpression(expression)) callbackName ??= expression.name.text
    }
    if (ts.isFunctionLike(parent) || ts.isBlock(parent)) break
  }
  return callbackName ?? '<anonymous>'
}

function lineSpan(source, start, end) {
  return (
    source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line -
    source.getLineAndCharacterOfPosition(start).line +
    1
  )
}

/** Whole syntax spans deliberately include all nested callbacks and returned methods. */
export function measureSource(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  if (source.parseDiagnostics.length) {
    const diagnostic = source.parseDiagnostics[0]
    throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
  }
  const test = isTestFile(file)
  const rule = test ? 'test-file800' : 'file400'
  const lines = text ? text.split(/\r\n|\r|\n/).length - (/[\r\n]$/.test(text) ? 1 : 0) : 0
  const spans = [{ key: `${file}::file`, file, rule, lines, limit: LIMITS[rule] }]
  const scopes = collectBindings(source)
  const ordinals = new Map()
  function symbol(chain, label) {
    label = encodeURIComponent(label)
    const stem = [...chain, label].join('/')
    const ordinal = (ordinals.get(stem) ?? 0) + 1
    ordinals.set(stem, ordinal)
    return [...chain, `${label}[${ordinal}]`]
  }
  function visit(node, chain) {
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isModuleDeclaration(node))
      chain = symbol(chain, node.name?.text ?? '<class>')
    if (
      ts.isObjectLiteralExpression(node) &&
      (ts.isVariableDeclaration(node.parent) || ts.isPropertyAssignment(node.parent))
    )
      chain = symbol(chain, propertyName(node.parent.name, source))
    if (ts.isFunctionLike(node) && node.body) {
      chain = symbol(chain, functionLabel(node, source))
      if (!test || !isSuiteContainer(node, scopes)) {
        spans.push({
          key: `${file}::${chain.join('/')}`,
          file,
          rule: 'function80',
          lines: lineSpan(source, node.getStart(source), node.end),
          limit: LIMITS.function80,
        })
      }
    }
    ts.forEachChild(node, (child) => visit(child, chain))
  }
  visit(source, [])
  return spans
}

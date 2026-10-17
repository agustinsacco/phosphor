import { describe, expect, it } from 'vitest'
import { SWARM_STATUS_KEY } from '../../../libs/pi-extensions/pi-ext/swarm'
import { LANE_RELOAD_STATUS_KEY } from '../../../libs/pi-extensions/pi-ext/lane-reload'
import { HEADROOM_STATUS_KEY } from '../../../libs/pi-extensions/pi-ext/headroom'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from '../../../apps/desktop/src/features/chat/composer/contextBreakdown'
import { HEADROOM_STATUS_KEY as RENDERER_HEADROOM_KEY } from '../../../apps/desktop/src/features/chat/composer/headroomStatus'
import { RATE_LIMIT_STATUS_KEY } from '../../../apps/desktop/src/features/chat/composer/rateLimit'
import { SUBAGENTS_STATUS_KEY } from '../../../apps/desktop/src/features/chat/subagentStatus'
import {
  parseFleetWidget,
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_WIDGET_KEY,
} from '../../../apps/desktop/src/features/chat/subagentRuns'
import { useExtensionUiStore } from '../../../apps/desktop/src/stores/extensionUi'
import fixture from './__fixtures__/status-wire.json'

// Runtime characterization uses public constants/parsers/store only, never pi or a provider.
describe('status wire runtime characterization', () => {
  it('preserves the lowercase status constants, including external Claude compatibility', () => {
    expect([
      SWARM_STATUS_KEY,
      CONTEXT_BREAKDOWN_STATUS_KEY,
      LANE_RELOAD_STATUS_KEY,
      HEADROOM_STATUS_KEY,
      RATE_LIMIT_STATUS_KEY,
      SUBAGENTS_STATUS_KEY,
    ]).toEqual(fixture.statuses.map(({ key }) => key))
    expect(RENDERER_HEADROOM_KEY).toBe(HEADROOM_STATUS_KEY)
    expect(SUBAGENT_ASYNC_WIDGET_KEY).toBe(fixture.asyncWidget.key)
    expect(SUBAGENT_INSPECT_WIDGET_KEY).toBe(fixture.structuredWidgets[1])
  })

  it('routes every status key unchanged and retracts only the named key', () => {
    const sessionId = 'status-wire-characterization'
    const store = useExtensionUiStore.getState()
    try {
      for (const { key } of fixture.statuses) {
        store.handleRequest(sessionId, {
          type: 'extension_ui_request',
          id: key,
          method: 'setStatus',
          statusKey: key,
          statusText: '{"wire":true}',
        })
      }
      expect(useExtensionUiStore.getState().statuses[sessionId]).toEqual(
        Object.fromEntries(fixture.statuses.map(({ key }) => [key, '{"wire":true}'])),
      )
      for (const { key } of fixture.statuses) {
        store.handleRequest(sessionId, {
          type: 'extension_ui_request',
          id: key,
          method: 'setStatus',
          statusKey: key,
        })
        expect(useExtensionUiStore.getState().statuses[sessionId]).not.toHaveProperty(key)
      }
    } finally {
      store.clearSession(sessionId)
    }
  })

  it('accepts the exact async widget prefix and rejects case changes', () => {
    const { prefix, kind, version } = fixture.asyncWidget
    const payload = JSON.stringify({ kind, version, generatedAt: 42, runs: [] })
    expect(parseFleetWidget([prefix + payload])).toEqual({
      generatedAt: 42,
      runs: [],
      omittedRuns: 0,
      incomplete: false,
      active: 0,
    })
    expect(parseFleetWidget([prefix.toLowerCase() + payload])).toBeNull()
    expect(parseFleetWidget([prefix + JSON.stringify({ kind, version: 2 })])).toBeNull()
  })
})

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, posix, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '../../..')
const hostPath = 'apps/desktop/src/features/extension-ui/ExtensionUiHosts.tsx'

function sourceFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sourceFiles(path)
    return /\.tsx?$/.test(path) && !/\.(test|d)\.tsx?$/.test(path) ? [path] : []
  })
}

function literalResolver(sources: Map<string, ts.SourceFile>) {
  const declarations = new Map<string, ts.Expression>()
  const imports = new Map<string, { path: string; name: string }>()
  const slot = (path: string, name: string) => `${path}#${name}`
  function modulePath(from: string, name: string): string {
    const base = name.startsWith('.')
      ? posix.normalize(`${dirname(from)}/${name}`)
      : name
          .replace(/^@\//, 'apps/desktop/src/')
          .replace(/^@phosphor\/pi-extensions\//, 'libs/pi-extensions/pi-ext/')
          .replace(/^(@shared|@phosphor\/shared)\//, 'libs/shared/src/')
    return (
      [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((p) => sources.has(p)) ?? base
    )
  }
  for (const [path, source] of sources) {
    const index = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isVariableStatement(node.parent.parent) &&
        ts.isSourceFile(node.parent.parent.parent)
      ) {
        const key = slot(path, node.name.text)
        if (declarations.has(key)) throw new Error(`Ambiguous literal declaration: ${key}`)
        declarations.set(key, node.initializer)
      }
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const bindings = node.importClause?.namedBindings
        if (bindings && ts.isNamedImports(bindings)) {
          for (const binding of bindings.elements) {
            imports.set(slot(path, binding.name.text), {
              path: modulePath(path, node.moduleSpecifier.text),
              name: (binding.propertyName ?? binding.name).text,
            })
          }
        }
      }
      ts.forEachChild(node, index)
    }
    index(source)
  }
  function literal(
    path: string,
    expression: ts.Expression | undefined,
    seen = new Set<string>(),
  ): string {
    if (!expression) throw new Error(`Missing wire expression in ${path}`)
    if (ts.isStringLiteralLike(expression)) return expression.text
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
      return literal(path, expression.expression, seen)
    }
    if (ts.isIdentifier(expression)) {
      const key = slot(path, expression.text)
      if (seen.has(key)) throw new Error(`Cyclic wire constant: ${key}`)
      seen.add(key)
      const imported = imports.get(key)
      return imported
        ? literal(imported.path, declarations.get(slot(imported.path, imported.name)), seen)
        : literal(path, declarations.get(key), seen)
    }
    throw new Error(`Unresolved wire expression in ${path}: ${expression.getText()}`)
  }
  return {
    literal,
    initializer: (path: string, name: string) => declarations.get(slot(path, name)),
  }
}

// Static literal audit, not a runtime snapshot of extension loaders. Only source is parsed.
function literalAudit(texts: Map<string, string>) {
  const sources = new Map(
    [...texts].map(([path, text]) => [
      path,
      ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true),
    ]),
  )
  const { literal, initializer } = literalResolver(sources)
  const producers = new Map<string, string[]>()
  const consumers = new Map<string, string[]>()
  const suppressionUses: string[] = []
  function record(
    target: Map<string, string[]>,
    path: string,
    expression: ts.Expression | undefined,
  ) {
    target.set(path, [...(target.get(path) ?? []), literal(path, expression)])
  }
  for (const [path, source] of sources) {
    const scan = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const bound = ts.isPropertyAccessExpression(callee) && callee.name.text === 'call'
        const target = bound ? callee.expression : callee
        const name = ts.isPropertyAccessExpression(target) ? target.name.text : target.getText()
        if (name === 'setStatus' && (bound || ts.isPropertyAccessExpression(target))) {
          record(producers, path, node.arguments[bound ? 1 : 0])
        }
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'has') {
          suppressionUses.push(callee.expression.getText())
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isElementAccessExpression(node.expression)) {
        const owner = node.expression.expression
        if (ts.isPropertyAccessExpression(owner) && owner.name.text === 'statuses') {
          record(consumers, path, node.argumentExpression)
        }
      }
      if (ts.isBinaryExpression(node) && ts.isPropertyAccessExpression(node.left)) {
        if (node.left.name.text === 'statusKey') record(consumers, path, node.right)
      }
      ts.forEachChild(node, scan)
    }
    scan(source)
  }
  function structuredSet(name: string): string[] {
    const expression = initializer(hostPath, name)
    if (
      !expression ||
      !ts.isNewExpression(expression) ||
      expression.expression.getText() !== 'Set'
    ) {
      throw new Error(`Missing structured wire Set: ${name}`)
    }
    const values = expression.arguments?.[0]
    if (!values || !ts.isArrayLiteralExpression(values)) throw new Error(`Nonliteral Set: ${name}`)
    return values.elements.map((value) => literal(hostPath, value))
  }
  return { producers, consumers, structuredSet, suppressionUses }
}

function assertWireKeys(actual: Iterable<string>, expected: string[]): void {
  const keys = [...new Set(actual)].sort()
  if (JSON.stringify(keys) !== JSON.stringify([...expected].sort())) {
    throw new Error(
      `Wire keys differ: actual=${JSON.stringify(keys)} expected=${JSON.stringify(expected)}`,
    )
  }
}

const auditedTexts = new Map(
  [
    ...sourceFiles('libs/pi-extensions/pi-ext'),
    ...sourceFiles('apps/desktop/src'),
    'libs/session-runtime/src/pi/lane-reload.ts',
  ].map((path) => [path, readFileSync(resolve(root, path), 'utf8')]),
)

describe('status wire AST literal audit', () => {
  it('accounts for every bundled producer and renderer/main consumer without unlisted keys', () => {
    const audit = literalAudit(auditedTexts)
    const native = fixture.statuses.filter(({ producer }) => producer)
    assertWireKeys(
      [...audit.producers.values()].flat(),
      native.map(({ key }) => key),
    )
    assertWireKeys(
      [...audit.consumers.values()].flat(),
      fixture.statuses.map(({ key }) => key),
    )
    for (const { key, producer, consumer } of fixture.statuses) {
      if (producer) expect(audit.producers.get(producer), producer).toContain(key)
      expect(audit.consumers.get(consumer), consumer).toContain(key)
    }
    expect(
      fixture.statuses
        .filter(({ producer }) => !producer)
        .map((entry) => entry.externalCompatibility),
    ).toEqual([
      '@saccolabs/pi-claude-cli >= 0.4.5; opaque external provider',
      '@saccolabs/pi-claude-cli >= 0.4.13; legacy sessions before 0.9.0',
    ])
  })

  it('keeps all structured status/widget keys out of prose rendering', () => {
    const audit = literalAudit(auditedTexts)
    assertWireKeys(
      audit.structuredSet('STRUCTURED_STATUS_KEYS'),
      fixture.statuses.map(({ key }) => key),
    )
    assertWireKeys(audit.structuredSet('STRUCTURED_WIDGET_KEYS'), fixture.structuredWidgets)
    expect(audit.suppressionUses).toContain('STRUCTURED_STATUS_KEYS')
    expect(audit.suppressionUses).toContain('STRUCTURED_WIDGET_KEYS')
  })

  it('recognizes direct strings, local constants, imported aliases and bound setStatus.call', () => {
    const audit = literalAudit(
      new Map([
        ['keys.ts', `export const KEY = 'phosphor-swarm'`],
        [
          'producer.ts',
          `
        import { KEY as ALIAS } from './keys'
        const LOCAL = 'phosphor-headroom'
        ctx.ui.setStatus('phosphor-reload', '')
        ui?.setStatus(LOCAL, '')
        const setStatus = ctx.ui?.setStatus
        setStatus.call(ctx.ui, ALIAS, '')
      `,
        ],
      ]),
    )
    expect(audit.producers.get('producer.ts')).toEqual([
      'phosphor-reload',
      'phosphor-headroom',
      'phosphor-swarm',
    ])
  })

  it.each(['Phosphor-swarm', 'phosphor-swrm', 'phosphor-new'])(
    'rejects changed/new producer key %s',
    (key) => {
      const texts = new Map(auditedTexts)
      const path = fixture.statuses[0]!.producer!
      texts.set(
        path,
        texts
          .get(path)!
          .replace("SWARM_STATUS_KEY = 'phosphor-swarm'", `SWARM_STATUS_KEY = '${key}'`),
      )
      const audit = literalAudit(texts)
      expect(() =>
        assertWireKeys(
          [...audit.producers.values()].flat(),
          fixture.statuses.filter(({ producer }) => producer).map(({ key }) => key),
        ),
      ).toThrow('Wire keys differ')
    },
  )

  it('rejects a missing consumer even when the key remains suppressed', () => {
    const texts = new Map(auditedTexts)
    const path = fixture.statuses[0]!.consumer
    texts.set(path, texts.get(path)!.replace('[SWARM_STATUS_KEY]', "['phosphor-misspelled']"))
    const audit = literalAudit(texts)
    expect(audit.structuredSet('STRUCTURED_STATUS_KEYS')).toContain('phosphor-swarm')
    expect(() => assertWireKeys(audit.consumers.get(path) ?? [], ['phosphor-swarm'])).toThrow(
      'Wire keys differ',
    )
  })

  it('rejects a removed consumer and an additional producer wire key', () => {
    const texts = new Map(auditedTexts)
    const path = fixture.statuses[0]!.consumer
    texts.set(
      path,
      texts.get(path)!.replace('s.statuses[sessionId]?.[SWARM_STATUS_KEY]', 'undefined'),
    )
    texts.set('added.ts', "ctx.ui.setStatus('phosphor-new', '')")
    const audit = literalAudit(texts)
    expect(audit.consumers.get(path)).toBeUndefined()
    expect(() => assertWireKeys(audit.consumers.get(path) ?? [], ['phosphor-swarm'])).toThrow(
      'Wire keys differ',
    )
    expect(() =>
      assertWireKeys(
        [...audit.producers.values()].flat(),
        fixture.statuses.filter(({ producer }) => producer).map(({ key }) => key),
      ),
    ).toThrow('Wire keys differ')
  })

  it.each(['STRUCTURED_STATUS_KEYS', 'STRUCTURED_WIDGET_KEYS'])(
    'rejects a missing suppression entry in %s',
    (name) => {
      const texts = new Map(auditedTexts)
      const token =
        name === 'STRUCTURED_STATUS_KEYS'
          ? 'CONTEXT_BREAKDOWN_STATUS_KEY'
          : 'SUBAGENT_ASYNC_WIDGET_KEY'
      texts.set(
        hostPath,
        texts
          .get(hostPath)!
          .replace(`const ${name} = new Set([\n  ${token},`, `const ${name} = new Set([`),
      )
      const keys = literalAudit(texts).structuredSet(name)
      expect(() =>
        assertWireKeys(
          keys,
          name === 'STRUCTURED_STATUS_KEYS'
            ? fixture.statuses.map(({ key }) => key)
            : fixture.structuredWidgets,
        ),
      ).toThrow('Wire keys differ')
    },
  )

  it('fails closed on dynamic producer expressions', () => {
    expect(() =>
      literalAudit(new Map([['producer.ts', 'ctx.ui.setStatus(computeKey(), "")']])),
    ).toThrow('Unresolved wire expression')
  })
})

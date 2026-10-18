import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { transform } from 'esbuild'
import { describe, expect, expectTypeOf, it } from 'vitest'
import type { BudgetApi as ExistingBudgetApi } from './context-budget'
import type contextBudget from './context-budget'
import type artifacts from './artifacts'
import type worktreePaths from './worktree-paths'
import type {
  BudgetApi,
  BudgetContext,
  CommandApi,
  EventApi,
  SessionEntryApi,
  SessionManager,
  ToolApi,
  ToolDefinition,
  ToolResult,
  UI,
} from './pi-api'

const api = join(import.meta.dirname, 'pi-api.ts')

describe('type-only pi API facets', () => {
  it('composes minimal facets assignable to existing extension capabilities', () => {
    type BudgetExtension = EventApi & BudgetApi & CommandApi<BudgetContext>
    expectTypeOf<BudgetExtension>().toExtend<ExistingBudgetApi>()
    expectTypeOf<BudgetExtension>().toExtend<Parameters<typeof contextBudget>[0]>()
    expectTypeOf<EventApi>().toExtend<Parameters<typeof worktreePaths>[0]>()
    expectTypeOf<EventApi>().toEqualTypeOf<Pick<Parameters<typeof artifacts>[0], 'on'>>()
    expectTypeOf<SessionManager['getBranch']>().returns.toEqualTypeOf<unknown[]>()
    expectTypeOf<SessionEntryApi['appendEntry']>().parameters.toEqualTypeOf<[string, unknown]>()
    expectTypeOf<UI['setWidget']>().parameters.toEqualTypeOf<[string, string[] | undefined]>()
  })

  it('preserves the tool parameters, context, details and update result types', () => {
    type Context = { sessionManager: Pick<SessionManager, 'getSessionId'> }
    type Definition = ToolDefinition<{ title: string }, Context, { version: number }>
    type Execute = Definition['execute']
    expectTypeOf<Parameters<Execute>[1]>().toEqualTypeOf<{ title: string }>()
    expectTypeOf<Parameters<Execute>[4]>().toEqualTypeOf<Context>()
    expectTypeOf<ReturnType<Execute>>().toEqualTypeOf<Promise<ToolResult<{ version: number }>>>()
    expectTypeOf<
      ToolApi<{ title: string }, Context, { version: number }>['registerTool']
    >().parameters.toEqualTypeOf<[Definition]>()
  })

  it('rejects a command handler that needs a different context under strict checking', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phosphor-pi-api-types-'))
    try {
      const fixture = join(directory, 'command.ts')
      writeFileSync(
        fixture,
        `
        import type { BudgetContext, CommandApi } from ${JSON.stringify(api)};
        declare const budget: CommandApi<BudgetContext>;
        budget.registerCommand('reload', {
          description: 'wrong command context',
          handler: async (_args: string, ctx: { reload(): Promise<void> }) => { await ctx.reload(); },
        });
      `,
      )
      const program = ts.createProgram([fixture], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        target: ts.ScriptTarget.ES2023,
        allowImportingTsExtensions: true,
      })
      const diagnostics = ts.getPreEmitDiagnostics(program)
      expect(diagnostics.map((diagnostic) => diagnostic.code)).toEqual([2322])
      expect(ts.flattenDiagnosticMessageText(diagnostics[0]!.messageText, '\n')).toContain(
        "Property 'reload' is missing in type 'BudgetContext'",
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('contains declarations only and emits no runtime module dependencies', async () => {
    const text = readFileSync(api, 'utf8')
    expect(text.split('\n').length).toBeLessThanOrEqual(300)
    const file = ts.createSourceFile(api, text, ts.ScriptTarget.Latest, true)
    expect(file.statements.length).toBeGreaterThan(0)
    expect(
      file.statements.every(
        (statement) => ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement),
      ),
    ).toBe(true)
    const emitted = await transform(text, { loader: 'ts', format: 'esm' })
    expect(emitted.code.trim()).toBe('')
  })
})

/** Type-only structural mirror of the pi capabilities used by bundled extensions.
 * pi supplies the implementation; consumers compose only the facets they need.
 * Event payloads stay unknown until an extension narrows its specific hook.
 */
export interface EventApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
}

export interface Command<Context> {
  description: string
  handler: (args: string, ctx: Context) => Promise<void>
}

/** The context is command-specific: reload, budget and snapshot are not interchangeable. */
export interface CommandApi<Context> {
  registerCommand: (name: string, command: Command<Context>) => void
}

export interface BudgetModel {
  provider: string
  id: string
  contextWindow: number
}

export interface BudgetContext {
  model?: BudgetModel
  isIdle(): boolean
  modelRegistry: { find(provider: string, id: string): BudgetModel | undefined }
}

export interface BudgetApi {
  setModel(model: BudgetModel): Promise<boolean>
  getThinkingLevel(): string
  setThinkingLevel(level: string): void
}

export interface ToolResult<Details> {
  content: Array<{ type: 'text'; text: string }>
  details: Details
}

export interface ToolDefinition<Parameters, Context, Details> {
  name: string
  label: string
  description: string
  parameters: unknown
  promptSnippet?: string
  promptGuidelines?: string[]
  execute: (
    toolCallId: string,
    parameters: Parameters,
    signal: AbortSignal | undefined,
    onUpdate: ((result: ToolResult<Details>) => void) | undefined,
    ctx: Context,
  ) => Promise<ToolResult<Details>>
}

export interface ToolApi<Parameters, Context, Details> {
  registerTool: (definition: ToolDefinition<Parameters, Context, Details>) => void
}

/** Branch entries are extension-owned data, narrowed by the reader. */
export interface SessionManager {
  getSessionId(): string
  getSessionFile(): string | undefined
  getBranch(): unknown[]
  buildContextEntries(): unknown[]
}

export interface SessionEntryApi {
  appendEntry(type: string, data: unknown): void
}

/** Select a UI capability with Pick when a context needs only one channel. */
export interface UI {
  setStatus(key: string, text: string | undefined): void
  setWidget(key: string, lines: string[] | undefined): void
  select(title: string, options: string[]): Promise<string | undefined>
}

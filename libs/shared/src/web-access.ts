/**
 * pi-web-access's search provider keys (`web-search.json`), shared by This
 * Mac and a Host. The file holds API keys: reads report which are configured,
 * by name, and never their values. Keys verified against pi-web-access 0.24.0;
 * the package supports more, reachable through the raw file.
 */
export const WEB_ACCESS_PROVIDERS = [
  { key: 'braveApiKey', label: 'Brave Search', hint: 'BSA_…' },
  { key: 'tavilyApiKey', label: 'Tavily', hint: 'tvly-…' },
  { key: 'exaApiKey', label: 'Exa', hint: 'exa-…' },
  { key: 'jinaApiKey', label: 'Jina Reader', hint: 'jina_…' },
  { key: 'kagiApiKey', label: 'Kagi', hint: '' },
  { key: 'serperApiKey', label: 'Serper', hint: '' },
  { key: 'openaiApiKey', label: 'OpenAI (search + summaries)', hint: 'sk-…' },
] as const

export type WebAccessKey = (typeof WEB_ACCESS_PROVIDERS)[number]['key']

export const WEB_ACCESS_KEYS: readonly WebAccessKey[] = WEB_ACCESS_PROVIDERS.map((p) => p.key)

export function isWebAccessKey(value: unknown): value is WebAccessKey {
  return typeof value === 'string' && (WEB_ACCESS_KEYS as readonly string[]).includes(value)
}

/** The longest key value a client may set. */
export const WEB_ACCESS_VALUE_MAX = 4096

/** A key value a client may set: one line of text, or a `$ENV_VAR` reference. */
export function isWebAccessKeyValue(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= WEB_ACCESS_VALUE_MAX &&
    // No control characters: the value is one line in a JSON file.
    ![...value].some((char) => char.charCodeAt(0) < 0x20 || char.charCodeAt(0) === 0x7f)
  )
}

/** The provider keys `config` sets to a non-empty string, in provider order. Names only. */
export function configuredWebAccessKeys(config: Record<string, unknown>): WebAccessKey[] {
  return WEB_ACCESS_KEYS.filter((key) => {
    const value = config[key]
    return typeof value === 'string' && value.length > 0
  })
}

/** This Mac's Web access read: the file's health and the configured key names. */
export interface WebAccessConfigState {
  path: string
  exists: boolean
  malformed: boolean
  error?: string
  configured: WebAccessKey[]
}

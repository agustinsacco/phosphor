import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

const rendererFiles = [
  'apps/desktop/src/**/*.{ts,tsx}',
  'apps/desktop/test/renderer/**/*.{ts,tsx}',
  'libs/client-ui/src/**/*.{ts,tsx}',
  'apps/web/src/**/*.{ts,tsx}',
]

// no-restricted-syntax must stay an error for prompt; this separate rule stages
// the nested RPC escape hatch as a warning, including computed literal access.
const phosphor = {
  rules: {
    'no-raw-pi-command': {
      meta: {
        type: 'problem',
        schema: [],
        messages: { rawRpc: 'Use piCall()/piCallOk() from @/lib/rpc to handle RPC failures.' },
      },
      create(context) {
        // `(window as X).phosphor!.piCommand` is the same access: see through TS wrappers.
        function unwrap(node) {
          while (
            node.type === 'TSAsExpression' ||
            node.type === 'TSNonNullExpression' ||
            node.type === 'TSSatisfiesExpression'
          )
            node = node.expression
          return node
        }
        function keyIs(property, name) {
          if (property.type === 'Literal') return property.value === name
          return (
            property.type === 'TemplateLiteral' &&
            property.expressions.length === 0 &&
            property.quasis[0]?.value.cooked === name
          )
        }
        function memberNamed(node, name) {
          node = unwrap(node)
          return (
            node.type === 'MemberExpression' &&
            (node.computed
              ? keyIs(node.property, name)
              : node.property.type === 'Identifier' && node.property.name === name)
          )
        }
        return {
          MemberExpression(node) {
            if (
              memberNamed(node, 'piCommand') &&
              memberNamed(node.object, 'phosphor') &&
              unwrap(unwrap(node.object).object).type === 'Identifier' &&
              unwrap(unwrap(node.object).object).name === 'window'
            ) {
              context.report({ node, messageId: 'rawRpc' })
            }
          },
        }
      },
    },
  },
}

// An unawaited promise loses its rejection: the IPC failures fixed in the
// engineering review started this way. no-floating-promises and
// no-misused-promises run in oxlint's type-aware pass (.oxlintrc.json), about
// 20x faster than typed ESLint; oxlint-suppressions.json is their one-way
// ratchet. ESLint stays syntax-only, so it never builds a TypeScript program.

export default tseslint.config(
  {
    ignores: [
      '**/out/**',
      'dist/**',
      '**/node_modules/**',
      '**/release/**',
      '.claude/**',
      '.phosphor/**',
      '.pidex/**',
      'apps/site/.astro/**',
      'apps/site/dist/**',
      'apps/host/dist/**',
      'apps/control/dist/**',
      'apps/web/dist/**',
      'apps/site/shots-raw/**',
      'apps/site/test-results/**',
      'apps/site/playwright-report/**',
      '**/*.cjs',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
  {
    files: rendererFiles,
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Warnings are an inventory for app owners, not a cleanup or a CI budget.
      'react-hooks/exhaustive-deps': 'warn',
      // Electron overrides window.prompt to throw "prompt() is not supported."
      // — every renderer prompt must go through promptText (stores/prompt.ts).
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='window'][property.name='prompt']",
          message:
            'window.prompt throws in Electron. Use promptText()/presentText() from @/stores/prompt.',
        },
      ],
    },
  },
  {
    files: rendererFiles,
    // Tests mock window.confirm on purpose; enforce app choices in production.
    ignores: ['**/*.test.{ts,tsx}', 'apps/desktop/test/renderer/**'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'window',
          property: 'confirm',
          message: 'Use an in-app confirmation dialog instead of window.confirm.',
        },
      ],
    },
  },
  {
    files: rendererFiles,
    ignores: [
      // The wrapper owns envelope handling; tests deliberately mock the raw API.
      'libs/client-ui/src/lib/rpc.ts',
      '**/*.test.{ts,tsx}',
      'apps/desktop/test/renderer/**',
    ],
    plugins: { phosphor },
    rules: { 'phosphor/no-raw-pi-command': 'error' },
  },
  {
    // The Host runs under plain Node: no Electron, no native Desktop modules,
    // and the libraries only through their package subpaths. boundary.test.ts
    // also checks that each subpath is exported.
    files: ['apps/host/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: ['electron', 'electron-store', 'electron-updater', 'node-pty'].map((name) => ({
            name,
            message: 'The Host runs under plain Node, without Electron or Desktop modules.',
          })),
          patterns: [
            {
              group: ['@/*', '@shared/*'],
              message: 'Import libraries as @phosphor/shared/* or @phosphor/session-runtime/*.',
            },
          ],
        },
      ],
    },
  },
  {
    // Maintainer scripts run under plain Node (no tsconfig project).
    files: [
      'tools/scripts/**/*.mjs',
      'apps/desktop/scripts/**/*.mjs',
      'apps/host/scripts/**/*.mjs',
      'apps/control/scripts/**/*.mjs',
      'apps/site/scripts/**/*.mjs',
    ],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
      },
    },
  },
)

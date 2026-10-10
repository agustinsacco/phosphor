import js from '@eslint/js'
import tseslint from 'typescript-eslint'

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
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    rules: {
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

import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'dist/**',
      'node_modules/**',
      'release/**',
      '.claude/**',
      '.phosphor/**',
      '.pidex/**',
      'site/.astro/**',
      'site/dist/**',
      'site/shots-raw/**',
      'site/test-results/**',
      'site/playwright-report/**',
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
    files: ['src/**/*.{ts,tsx}'],
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
    // Maintainer scripts run under plain Node (no tsconfig project).
    files: ['scripts/**/*.mjs', 'site/scripts/**/*.mjs'],
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

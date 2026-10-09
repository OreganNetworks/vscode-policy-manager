import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['out/', 'node_modules/', '.vscode-test/', '.claude/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', disallowTypeAnnotations: false, fixStyle: 'inline-type-imports' },
      ],
      'no-console': 'error',
    },
  },
  {
    // Only extension.ts talks to VS Code.  Everything else takes a port, so node:test can load it without an editor.
    files: ['src/**/*.ts'],
    ignores: ['src/extension.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { paths: [{ name: 'vscode', message: 'Only src/extension.ts imports vscode - take a port instead.' }] },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
    },
  },
)

// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'out/**',
      'release/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      '.githooks/_/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  comments.recommended,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // `any` is allowed only with an eslint-disable comment that carries a description
      // (enforced by eslint-comments/require-description below).
      '@typescript-eslint/no-explicit-any': 'error',
      '@eslint-community/eslint-comments/require-description': ['error', { ignore: [] }],
      '@eslint-community/eslint-comments/no-unused-disable': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      // ReadonlyArray<T> reads better in contracts than `readonly T[]`.
      '@typescript-eslint/array-type': 'off',
      // `service<T>(name): T` style lookups are deliberate.
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // `result: void` in the IPC channel map is the honest type for fire-and-forget handlers.
      '@typescript-eslint/no-invalid-void-type': 'off',
      '@typescript-eslint/dot-notation': ['error', { allowIndexSignaturePropertyAccess: true }],
      '@typescript-eslint/no-non-null-assertion': 'error',
      'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['scripts/**/*.ts', 'test/**/*.ts', '*.config.ts', 'eslint.config.js'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
);

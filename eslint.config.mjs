import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    ignores: [
      '.artifacts/**',
      'backend/model/api/target/**',
      'node_modules/**',
      'dist/**',
      'event-kit/**',
      'logs/**',
      'var/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  { files: ['**/*.mjs', '**/*.js'], languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] } },
];

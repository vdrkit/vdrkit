// SPDX-License-Identifier: AGPL-3.0-only
// correctness only, no style rules
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

const PROJECTS = [
  { files: ['packages/core/src/**/*.ts'], project: './packages/core/tsconfig.json' },
  { files: ['apps/server/src/**/*.ts', 'apps/server/scripts/**/*.ts'], project: './apps/server/tsconfig.dev.json' },
  {
    files: ['apps/dataroom/src/**/*.{ts,tsx}', 'apps/dataroom/e2e/**/*.ts', 'apps/dataroom/playwright.config.ts', 'apps/dataroom/next.config.ts'],
    project: './apps/dataroom/tsconfig.json',
  },
];

export default defineConfig(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.next*/**', '**/test-results/**', '**/next-env.d.ts'] },
  { linterOptions: { reportUnusedDisableDirectives: 'error' } },
  ...PROJECTS.map(({ files, project }) => ({
    files,
    languageOptions: { parser: tseslint.parser, parserOptions: { project, tsconfigRootDir: import.meta.dirname } },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
    },
  })),
  {
    files: ['apps/dataroom/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      // the API client never rejects
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
);

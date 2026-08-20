import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Ceilings for module and function length. `npm run lint` runs with `--max-warnings=0`, so any
 * breach — these ceilings or anything else — fails the gate outright. There is no grandfathered
 * warning budget: a new oversized module is a build break the moment it appears.
 */
const MAX_LINES = 1000;
const MAX_LINES_PER_FUNCTION = 200;

const maxLines = ['warn', { max: MAX_LINES, skipBlankLines: true, skipComments: true }];
const maxLinesPerFunction = [
  'warn',
  { max: MAX_LINES_PER_FUNCTION, skipBlankLines: true, skipComments: true, IIFEs: true },
];

export default tseslint.config(
  {
    ignores: [
      'coverage/**',
      'dist/**',
      'node_modules/**',
      'outputs/**',
      'release/**',
      'work/**',
      'v2rayN-*/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vite.config.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      'max-lines': maxLines,
    },
  },
  {
    files: ['src/**/*.ts', 'vite.config.ts'],
    rules: {
      'max-lines-per-function': maxLinesPerFunction,
    },
  },
  {
    // Build and smoke scripts run under plain Node, outside the TypeScript program.
    files: ['scripts/**/*.{mjs,cjs,js}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      ecmaVersion: 2024,
      globals: globals.node,
    },
    rules: {
      'max-lines': maxLines,
      'max-lines-per-function': maxLinesPerFunction,
    },
  },
  {
    files: ['scripts/**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
    },
    rules: {
      // `require()` is the module syntax for `.cjs`, not a legacy import style.
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
    },
  },
);

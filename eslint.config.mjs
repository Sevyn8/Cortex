import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// Type-aware linting requires files to be in a tsconfig. Scope the
// tseslint type-checked configs to workspace TS only; config files
// (.cjs / .mjs / root .js) get the non-type-aware baseline.
const WORKSPACE_TS = [
  'packages/**/*.ts',
  'packages/**/*.tsx',
  'apps/**/*.ts',
  'apps/**/*.tsx',
  'services/**/*.ts',
  'services/**/*.tsx',
];

export default [
  js.configs.recommended,

  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: WORKSPACE_TS,
  })),
  ...tseslint.configs.stylisticTypeChecked.map((config) => ({
    ...config,
    files: WORKSPACE_TS,
  })),

  {
    files: WORKSPACE_TS,
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // Root config files + scripts: ESM (.mjs / .js)
  {
    files: ['**/*.mjs', '**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  // CommonJS config files (.cjs)
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'commonjs',
      globals: { ...globals.node },
    },
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  prettier,

  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/node_modules/**',
      '**/.husky/_/**',
      '**/coverage/**',
    ],
  },
];

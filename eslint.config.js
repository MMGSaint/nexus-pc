// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-syntax': [
        'error',
        {
          // NEXUS must never open a network listener. Local IPC uses a named pipe
          // (Windows) or a unix domain socket (POSIX) via the path form of listen().
          selector:
            "CallExpression[callee.property.name='listen'] > ObjectExpression:has(Property[key.name='port'])",
          message:
            'NEXUS must not bind a TCP port. Use the local IPC transport (named pipe / unix socket) instead.',
        },
        {
          selector: "ImportDeclaration[source.value='dgram']",
          message: 'NEXUS must not open UDP sockets.',
        },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Build scripts run under Node directly, outside the TypeScript project.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
);

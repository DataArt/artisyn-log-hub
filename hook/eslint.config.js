'use strict';

const js = require('@eslint/js');

/** @type {import('eslint').Linter.FlatConfig[]} */
module.exports = [
  // Apply recommended rules as a baseline
  js.configs.recommended,

  {
    // Target all JS files in the project
    files: ['**/*.js'],

    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        // Node.js globals
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },

    rules: {
      // Catch likely bugs
      'no-unused-vars': ['warn', { args: 'after-used', ignoreRestSiblings: true }],
      'no-undef': 'error',

      // Style — match the existing source file conventions
      'semi': ['error', 'always'],
      'quotes': ['error', 'single', { avoidEscape: true }],

      // console is intentional in a CLI / hook script
      'no-console': 'off',

      // Useful quality rules
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': ['warn', { destructuring: 'all' }],
    },
  },

  {
    // Ignore generated / dependency directories
    ignores: ['node_modules/**'],
  },
];

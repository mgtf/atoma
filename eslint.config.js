// @ts-check
/**
 * ESLint flat config.
 *
 * TYPE-AWARE ON PURPOSE. `tsc --noEmit` already covers what the type system
 * can prove; a linter that only re-checked syntax would add ceremony and find
 * nothing. The rules earning their place here are the ones the compiler cannot
 * express — a promise nobody awaited, an `await` on a non-thenable, an async
 * callback handed to something expecting void. This codebase is almost
 * entirely async orchestration, so that is exactly its bug class: a floating
 * promise in a supervise loop is a run that silently does not wait.
 *
 * Scope covers `tests/` too, via `tsconfig.all.json`. The build tsconfig
 * excludes tests (they are never emitted), and without a lint-only project the
 * type-aware rules would skip the entire suite without saying so.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**', 'node_modules/**', 'coverage/**', 'runs/**', 'build/**', 'skills/**',
      // Benchmark SEED fixtures are deliverables-under-test copied into a run's
      // workspace, not project source. They deliberately look like a third-party
      // CLI (their own package.json, their own module system) and belong to no
      // tsconfig — linting them type-aware fails on "not found in any project".
      'benchmark/seeds/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        project: ['./tsconfig.all.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      // A disable comment for a rule that no longer fires is dead code that
      // reads as a live caveat. Surfacing them is how the four stale
      // `no-console` directives in this repo were found.
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // ── the rules that pay for the whole setup ──────────────────────────
      // Async correctness. Not stylistic: an unawaited promise in the
      // supervise loop is work the run does not wait for.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // OFF, measured: 128 hits, every one a hook or client method that must
      // be `async` to satisfy an interface returning a Promise
      // (SupervisionHooks.applyByScope, LlmClient.complete in the mocks) while
      // one branch happens not to await. The rule cannot see the contract, so
      // its signal here is entirely structural.
      '@typescript-eslint/require-await': 'off',

      // ── calibrated down, with reasons ───────────────────────────────────
      // `any` appears where LLM output is parsed before a zod schema narrows
      // it, and in test doubles. The schemas are the real guard; making these
      // errors would mean asserting types we deliberately do not trust yet.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // Template literals interpolate counters, model ids and costs; the
      // stringification is intended everywhere it appears.
      '@typescript-eslint/restrict-template-expressions': 'off',

      // Underscore prefix is the established opt-out for a deliberately
      // unused binding (caught errors included — several `catch {}` blocks
      // here are documented as intentionally swallowing).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // Tests assert on shapes that do not exist at compile time and build
    // deliberately malformed payloads to prove the parsers survive them.
    //
    // `no-explicit-any` is deliberately NOT disabled here. The suite already
    // carries ~40 hand-written `eslint-disable-next-line` comments for it,
    // which means its author wanted the rule ON with local opt-outs. Turning
    // it off would silently kill 40 deliberate annotations and lose the
    // record of where an `any` was a considered choice.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
  {
    // Plain-Node analysis scripts: no TS project, no type information.
    files: ['benchmark/**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
    rules: {
      // Spread FIRST. A bare `rules:` key replaces the spread's own rules
      // wholesale, which silently re-arms every type-aware rule on files that
      // have no type information — ESLint then dies on the first one.
      ...tseslint.configs.disableTypeChecked.rules,
      'no-empty': 'off',
    },
  }
);

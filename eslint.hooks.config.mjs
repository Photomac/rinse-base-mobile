// Merge gate: the Rules of Hooks, and nothing else.
//
// On 2026-09-03 the WEB app shipped a `useState` below an early return in
// DashboardPage. React threw "Rendered more hooks than during the previous
// render" the moment data loaded, and the owner dashboard was down for every
// tenant for ninety minutes. tsc passed, the build passed, the deploy went
// green. The web repo now fails its build on this rule (rinsebase-app #876).
// This app had no lint at all, and here the same mistake would reach crew
// phones over the air mid-clean.
//
// One rule on purpose: its violations are guaranteed runtime crashes. Style
// and exhaustive-deps findings are not gated; a gate that fires on backlog
// noise gets removed.
//
// WHY THERE IS NO `lint:hooks` SCRIPT IN package.json: `package.json` scripts
// are an input to the fingerprint runtime hash (see fingerprint.config.js).
// Adding one moves the OTA lane off the one the 1.1.5 store builds are on, and
// every `eas update` after that reaches nobody. So the gate runs in CI
// (.github/workflows/rules-of-hooks.yml) and by hand before publishing:
//
//   npx eslint --config eslint.hooks.config.mjs --no-config-lookup --max-warnings 0 .
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `.claude/worktrees` holds whole checkouts of this repo; linting them would
  // report every violation once per worktree.
  globalIgnores(['ios', 'android', 'dist', '.expo', '.claude', 'assets']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [tseslint.configs.base],
    // Any `eslint-disable react-hooks/exhaustive-deps` comment would otherwise
    // raise an "unused directive" warning here, since that rule is off.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
    },
  },
])

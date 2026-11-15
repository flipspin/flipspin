import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { readFileSync } from 'node:fs'

// Existing files awaiting stricter lint rules; remove entries as features are typed.
const typingPending = JSON.parse(readFileSync(new URL('./eslint-typing-pending.json', import.meta.url), 'utf8'))
  .map(file => `**/${file}`)

const outputRules = [
  { selector: "JSXOpeningElement[name.name='audio']", message: 'Media element output is retired; use the playback engine.' },
  { selector: "NewExpression:matches([callee.name='Audio'], [callee.property.name='Audio'], [callee.property.value='Audio'])", message: 'Only player/engine may produce audio output.' },
  { selector: "CallExpression:matches([callee.property.name='createMediaElementSource'], [callee.property.value='createMediaElementSource'])", message: 'Media element output is retired; use the playback engine.' },
  // player.play is the queue action; result.current.play is its hook test.
  // Only this.engine.play invokes the transport port outside engine/.
  { selector: "CallExpression:matches([callee.property.name='play'], [callee.property.value='play']):not([callee.object.name='player']):not([callee.object.object.name='result'][callee.object.property.name='current']):not([callee.object.object.type='ThisExpression'][callee.object.property.name='engine'])", message: 'Transport play belongs to the engine port; never play a media element.' },
  { selector: "MemberExpression:matches([property.name='destination'], [property.value='destination'])", message: 'Only the engine and audioGraph may connect output.' },
]
// Display clocks and playback persistence do not check server state.
const localClocks = [
  'auth/CodeSignIn.tsx', 'auth/SignInRequestSheet.tsx', 'connection/ConnectionDetails.tsx',
  'spotify-import/ProgressPanel.tsx', 'player/position.ts', 'player/trace.ts',
  'shell/usePageSwitchLog.ts', 'viz/VizOverlay.tsx', 'dashboard/Dashboard.tsx', 'lyrics/useLyricsSync.ts',
].map(file => `**/src/${file}`)
const progressPolls = Object.keys(JSON.parse(readFileSync(new URL('./eslint-poll-baseline.json', import.meta.url), 'utf8'))).map(file => `**/${file}`)
const streamRules = [
  { selector: "Property:matches([key.name='refetchInterval'], [key.value='refetchInterval']):not([value.type='Literal'][value.raw=/^[0-9]/])", message: 'Use change events; only allow-listed running progress may poll.' },
  { selector: "CallExpression[callee.name=/^(startPoll|watchQueryPoll)$/]", message: 'Use watchChanges; only allow-listed running progress may poll.' },
]
const pollRules = [
  { selector: "Property:matches([key.name='refetchInterval'], [key.value='refetchInterval'])[value.type='Literal'][value.raw=/^[0-9]/]", message: 'Use the shared data/poll policy for server polling.' },
  { selector: "CallExpression:matches([callee.name='setInterval'], [callee.property.name='setInterval'], [callee.property.value='setInterval'])", message: 'Use startPoll from data/poll for server checks; local clocks are explicitly allow-listed.' },
]
// Production imports must use the feature tree; old paths serve plugins only.
const generationImport = '(?:^|/)(?:next/|app/(?:components|shell|pages)/|app/App(?:\\.|$))'
const generationMessage = 'Use the feature tree; deprecated paths are reserved for external plugins.'
const generationRules = [
  'ImportExpression[source.value',
  'TSImportType[source.value',
].map(selector => ({
  selector: `${selector}=/${generationImport.replaceAll('/', '\\/')}/]`,
  message: generationMessage,
}))

export default [
  // `legacy/**` is dead reference code (imported nowhere); don't lint it.
  // Local private snapshots may live under src/vendor; the maintained kit is in src/ui.
  { ignores: ['dist', 'build', 'legacy/**', 'renderer/legacy/**', '**/src/vendor/**'] },
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2020,
      // __APP_VERSION__ is injected by Vite's `define` (see vite.config.js).
      globals: { ...globals.browser, __APP_VERSION__: 'readonly' },
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
      parser: tseslint.parser,
    },
    plugins: {
      '@typescript-eslint': tseslint.plugin,
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      'no-undef': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
    },
  },
  // Preserve existing typing debt without a second application tree. New files
  // receive the recommended rules; the pending list may shrink during typing.
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: ['**/src/**/*.{ts,tsx}'],
    ignores: typingPending,
  })),
  {
    files: ['**/src/**/*.{ts,tsx}'],
    ignores: typingPending,
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Boundary warnings are counted by noHandTypes.test.ts in both lint and
    // test. Existing debt stays visible; a new file or an increased count fails.
    // Include JS as well: adding a JS file must not bypass the native boundary.
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    ignores: ['**/src/bridge.ts', '**/src/desktop/tauri.ts', '**/src/web/*'],
    languageOptions: { parser: tseslint.parser },
    rules: {
      'no-restricted-properties': ['warn', {
        object: 'window',
        property: 'krobi',
        message: 'Use bridge() from bridge instead of accessing the native shell directly.',
      }],
    },
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    ignores: ['**/src/player/engine/**', '**/src/stems/audioGraph.ts', '**/src/stems/audioGraph.test.*'],
    rules: { 'no-restricted-syntax': ['warn', ...outputRules] },
  },
  {
    files: ['**/src/**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    // This test deliberately imports deprecated paths to prove forwarding.
    ignores: ['**/src/plugins/host.test.tsx', '**/src/plugins/*/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: generationImport, message: generationMessage }] }],
    },
  },
  {
    files: ['**/src/**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    ignores: ['**/src/plugins/host.test.tsx', '**/src/plugins/*/**', '**/src/player/engine/**', '**/src/stems/audioGraph.ts', '**/src/stems/audioGraph.test.*'],
    rules: { 'no-restricted-syntax': ['error', ...outputRules, ...generationRules, ...pollRules] },
  },
  {
    files: ['**/src/player/engine/**/*.{ts,tsx}', '**/src/stems/audioGraph.ts', '**/src/stems/audioGraph.test.*'],
    rules: { 'no-restricted-syntax': ['error', ...generationRules, ...pollRules] },
  },
  {
    files: localClocks,
    rules: { 'no-restricted-syntax': ['error', ...outputRules, ...generationRules, pollRules[0]] },
  },
  {
    files: ['**/src/data/poll.ts'],
    rules: { 'no-restricted-syntax': ['error', ...outputRules, ...generationRules] },
  },
  {
    files: ['**/src/**/*.{js,jsx,mjs,cjs,ts,tsx}'],
    ignores: [...progressPolls, ...localClocks, '**/*.test.*', '**/src/player/engine/**', '**/src/stems/audioGraph.ts', '**/src/plugins/*/**'],
    rules: { 'no-restricted-syntax': ['error', ...outputRules, ...generationRules, ...pollRules, ...streamRules] },
  },
  {
    // Node-context config files (run by Vite/Node, not the browser).
    // Globs are resolved from the repo root (where `npm run lint` runs), so
    // match nested paths like renderer/vite.config.js; not just the basename.
    files: ['**/*.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
]

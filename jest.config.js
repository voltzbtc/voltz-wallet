const preset = require('@react-native/jest-preset')

module.exports = {
  ...preset,
  // Metro compiles .svg through react-native-svg-transformer, which jest does not run, so every svg
  // import resolves to a mock instead.
  moduleNameMapper: {
    ...(preset.moduleNameMapper ?? {}),
    '\\.svg$': '<rootDir>/__mocks__/svgMock.js',
    // The sync and rename durable writes go through act on the in-memory react-native-fs of the same
    // module registry. jest.mock would not do: a mock loaded once outside jest.isolateModules is
    // handed to every isolated registry after it, over the first registry's files, while each
    // isolated registry, a test's next launch of the app, has files of its own.
    '^(?:\\.\\./)+specs/NativeVoltzDurable$': '<rootDir>/specs/__mocks__/NativeVoltzDurable.ts',
  },
  // The preset transpiles react-native and @react-native, but not
  // @react-navigation (pure ESM) nor the native navigation modules. Without this,
  // importing Home (which uses @react-navigation/native) breaks with
  // "Unexpected token 'export'".
  transformIgnorePatterns: [
    // @scure/@noble (BIP32 fingerprint derivation) ship ESM; transform them too, like the nav libs.
    'node_modules/(?!(?:jest-)?(@react-native|react-native|@react-navigation|react-native-[^/]+|@scure|@noble)/)',
  ],
  // App renders GestureHandlerRootView, which throws without the library's own TurboModule mock, so
  // that setup file is appended to the preset's.
  setupFiles: [
    ...(preset.setupFiles ?? []),
    require.resolve('react-native-gesture-handler/jestSetup'),
  ],
  // The reanimated mock uses jest.mock, which only exists after the test
  // framework is installed (setupFiles runs before). Hence setupFilesAfterEnv.
  setupFilesAfterEnv: ['./jest.setup.js'],
  // __tests__/support holds helpers the suites share, which are not suites themselves.
  // The mutation runner copies the repository into a sandbox under this directory, tests included.
  // A run left behind, or one still going, makes a plain `jest` collect both copies: 12179 tests
  // over 910 suites, most of them the same tests failing against a half-written sandbox. The count
  // is the only thing that looks wrong, and it looks wrong in the direction of more.
  testPathIgnorePatterns: ['/node_modules/', '/.stryker-tmp/', '<rootDir>/.claude/', '/__tests__/support/'],
  // Claude Code keeps git worktrees of this repository under .claude/worktrees, each with its own
  // __mocks__. Jest would collect their tests and pick their mocks over these ones, failing suites
  // that pass on their own, so the directory stays out of the module map as well as the test list.
  // Both entries start at <rootDir> because Jest matches them against absolute paths, and a
  // worktree's own path contains /.claude/, so a bare '/.claude/' ignores every test run inside one.
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],
  // A CI runner is shared and slower than a laptop, so a screen test that takes under a second
  // locally can pass jest's default 5 s there. A hang still fails, at 15 s.
  testTimeout: process.env.CI ? 15000 : 5000,
}

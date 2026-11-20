module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    [
      'module:react-native-dotenv',
      {
        envName: 'APP_ENV',
        moduleName: '@env',
        path: '.env',
        // With no .env present (CI, fresh clone) the build proceeds and the var
        // is undefined, which the code handles explicitly.
        allowUndefined: true,
      },
    ],
    // Required by react-native-reanimated 4 (drawer). MUST be the last plugin.
    // In reanimated 4 the plugin lives in the worklets package.
    'react-native-worklets/plugin',
  ],
  env: {
    // Metro takes a dynamic import() apart itself. Node runs Jest's modules with no loader behind
    // import(), so under Jest it has to become a require.
    test: {
      plugins: ['@babel/plugin-transform-dynamic-import'],
    },
  },
};

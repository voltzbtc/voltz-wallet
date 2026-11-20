/**
 * @format
 */

// Must be the bundle's first import. @noble/hashes (used by bip39) freezes
// globalThis.crypto when loaded, so the polyfill must be installed before any
// other module runs.
import 'react-native-get-random-values';
import { Buffer } from 'buffer';

// react-native-gesture-handler must be imported at the top of the entry (before
// navigation), but after the crypto polyfills which have to come first.
import 'react-native-gesture-handler';

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// Screens are never frozen, neither by enableFreeze nor by a freezeOnBlur option. react-freeze suspends
// each hidden screen on one shared thenable, and React 19 retries three or more such boundaries in a
// loop (react/react#37556), committing about 150 times a second and starving every JS timer.

// bip39 uses Node's Buffer (generateMnemonic/mnemonicToSeed), which Hermes does not expose; without
// this polyfill, creating a wallet throws "Property 'Buffer' doesn't exist".
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

AppRegistry.registerComponent(appName, () => App);

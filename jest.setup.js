/* eslint-env jest */
// The drawer pulls in reanimated worklets, which do not run in Jest (reanimated 4's own mock still
// touches native worklets). The passthrough keeps the nav tree mountable. bottom-tabs and
// native-stack have no reanimated dependency and stay real.
jest.mock('@react-navigation/drawer', () => {
  const react = require('react')
  return {
    createDrawerNavigator: () => ({
      Navigator: ({ children }) => react.createElement(react.Fragment, null, children),
      Screen: props => (props.component ? react.createElement(props.component) : null),
    }),
    DrawerContentScrollView: props => react.createElement(react.Fragment, null, props.children),
    useDrawerStatus: () => 'closed',
  }
})

// Drag-to-reorder needs reanimated + gesture-handler, which do not run in Jest. The row data comes
// from buildSparkAssetList, covered directly in assets.test.
jest.mock('./src/components/AssetList', () => ({ AssetList: () => null }))

// Same drag-to-reorder case; the reorder helper in wallet/walletRegistry is covered directly.
jest.mock('./src/components/WalletList', () => ({ WalletList: () => null }))

// Enters through reanimated, whose entry a suite cannot run. reenter.test.tsx covers it directly, and a
// screen is read through the `beat` prop this stand-in receives.
jest.mock('./src/components/Reenter', () => ({ Reenter: ({ children }) => children }))

// Pulses via reanimated; stubbed to null so a screen in its loading state still mounts.
jest.mock('./src/components/Skeleton', () => ({ Skeleton: () => null }))

// Animates via reanimated + react-native-svg worklets. The host wiring and the pure event mapper are
// covered directly.
jest.mock('./src/components/ReceivedOverlay', () => ({ ReceivedOverlay: () => null }))

// Same reanimated + react-native-svg case. Finishing immediately lets App-rendering tests exercise
// the real splashDone hand-off without pulling in worklets.
jest.mock('./src/screens/SplashScreen', () => {
  const react = require('react')
  return {
    SplashScreen: ({ onDone }) => {
      react.useEffect(() => onDone(), [onDone])
      return null
    },
  }
})

// The store bridge is a TurboModule with no native side under Jest. Its double in specs/__mocks__ can
// fail, queue and deliver late; tests reach its controls through jest.requireMock.
jest.mock('./specs/NativeVoltzStore')

// The iOS notification bridge, the same kind of TurboModule. Its double also stands for the iPhone's
// APNs state, which the Firebase double reads, and each test starts on a fresh install.
jest.mock('./specs/NativeVoltzNotifications')
beforeEach(() => {
  jest.requireMock('./specs/NativeVoltzNotifications').resetDevice()
})

// The cover and the boot clock the lock measures time away with, standing still unless a test moves it.
jest.mock('./specs/NativeVoltzPrivacy')
beforeEach(() => {
  jest.requireMock('./specs/NativeVoltzPrivacy').device.reset()
})

// The stores' age signal, which marks nobody as regulated unless a test says otherwise.
jest.mock('./specs/NativeVoltzAge')
beforeEach(() => {
  jest.requireMock('./specs/NativeVoltzAge').ageStore.reset()
})

// Home reads the update notice over the network once it is drawn, and every suite that renders it
// stays off the network with no notice to show. __tests__/updateNotice.test.ts uses the real reader.
jest.mock('./src/wallet/updateNotice', () => ({
  ...jest.requireActual('./src/wallet/updateNotice'),
  readUpdateNotice: jest.fn(async () => null),
}))

// The strip on Home reads Kraken's series, and every suite that renders it stays off the network with
// no change to show. __tests__/priceStrip.test.tsx uses the real reader.
jest.mock('./src/hooks/useBtcDayChange', () => ({ useBtcDayChange: () => null }))

// wallet/nfc requires react-native-nfc-manager only when NativeModules.NfcManager exists, guarding a
// native-init crash. Declaring it present routes tests through the mocked wrapper.
require('react-native').NativeModules.NfcManager = require('react-native').NativeModules.NfcManager || {}

// A react-native export is a getter that requires its module on first read, and a cold cache
// transforms that module on the spot. Left to the first render, those seconds count against whichever
// test renders first, and a cold runner times it out. Reading the exports the app uses here moves the
// cost into setup, outside any test's limit.
for (const name of require('./jest.rnWarmup')) {
  Reflect.get(require('react-native'), name)
}

// Native module that relaunches the app to apply an RTL/LTR flip; stubbed for language-switch tests.
jest.mock('react-native-restart', () => ({ __esModule: true, default: { restart: jest.fn() } }))

// Settings resolves the iOS SettingsManager TurboModule on first read, which Jest does not have, and
// every language change writes AppleLanguages through it (src/i18n/bundleLanguage.ts).
jest.mock('react-native/Libraries/Settings/NativeSettingsManager', () => ({
  __esModule: true,
  default: { getConstants: () => ({ settings: {} }), setValues: jest.fn(), deleteValues: jest.fn() },
}))

// react-test-renderer has no automatic cleanup. A tree left mounted keeps scheduling React work,
// and once Jest tears the environment down the lazy react-native requires it triggers throw,
// failing tests that had nothing to do with that tree. Running with `jest --runInBand` makes this
// fatal, since one shared environment lets a suite abort the whole run; the parallel default hides
// it by giving each suite its own worker.
const reactTestRenderer = require('react-test-renderer')
const mountedTrees = new Set()
const createTree = reactTestRenderer.create.bind(reactTestRenderer)
reactTestRenderer.create = (...args) => {
  const tree = createTree(...args)
  mountedTrees.add(tree)
  return tree
}
afterEach(() => {
  const trees = [...mountedTrees]
  mountedTrees.clear()
  reactTestRenderer.act(() => {
    trees.forEach(tree => tree.unmount())
  })
})

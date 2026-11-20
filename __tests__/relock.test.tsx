import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, AppState, BackHandler, DeviceEventEmitter, Text, View } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { PinScreen } from '../src/screens/PinScreen'
import { BiometricOfferScreen } from '../src/screens/BiometricOfferScreen'
import { activeWalletOwingWords } from '../src/wallet/passkey'
import {
  RELOCK_AFTER_MS,
  RELOCK_AFTER_OWN_MS,
  asOwnActivity,
  liftCover,
  liftCoverAfterModals,
  mustLock,
  readAway,
} from '../src/wallet/relock'
import { LIFT_FALLBACK_MS } from '../src/hooks/useRelock'

// The Android module, which calls listeners newest first, so a back press goes through the code a
// phone runs.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/BackHandler.android'),
)

// What the navigator mock exposes, so a test can type under the lock, count its mounts and see which
// sheet was asked to close.
const mockNav = { mounts: 0, closes: 0, keptAsks: 0, say: (_line: string | null) => undefined as void }

// A navigator with state of its own, two open sheets and a line it says to a screen reader, which is
// what a review, a typed amount and a send in flight look like to the lock. One sheet closes when
// asked; the other is kept by its owner, as a send in flight keeps its own.
jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText, Pressable: RNPressable, View: RNView } = require('react-native')
  const { Sheet } = require('../src/components/Sheet')
  const { useAnnounced } = require('../src/hooks/useAnnounced')
  function RootNavigator() {
    const [typed, setTyped] = react.useState('')
    const [line, setLine] = react.useState(null)
    const [open, setOpen] = react.useState(true)
    react.useEffect(() => {
      mockNav.mounts += 1
    }, [])
    mockNav.say = setLine
    useAnnounced(line)
    return react.createElement(
      RNView,
      null,
      react.createElement(RNText, null, 'NAVIGATOR'),
      react.createElement(RNText, null, `typed:${typed}`),
      react.createElement(RNPressable, { testID: 'type', onPress: () => setTyped((s: string) => `${s}7`) }),
      react.createElement(
        Sheet,
        {
          visible: open,
          onClose: () => {
            mockNav.closes += 1
            setOpen(false)
          },
          closeLabel: 'close',
        },
        react.createElement(RNText, null, 'SHEET CONTENT'),
      ),
      react.createElement(
        Sheet,
        { visible: true, onClose: () => (mockNav.keptAsks += 1), closeLabel: 'kept' },
        react.createElement(RNText, null, 'KEPT SHEET'),
      ),
    )
  }
  return { RootNavigator }
})

// The owed passkey words, which only a live passkey build reaches, answered by the test.
jest.mock('../src/wallet/passkey', () => ({
  ...jest.requireActual('../src/wallet/passkey'),
  activeWalletOwingWords: jest.fn(async () => null),
}))

// The words screen holds the callbacks it was last given, as the real one does across its own write.
const mockWords: { onDone: () => void; onVerifying: (verifying: boolean) => void } = {
  onDone: () => undefined,
  onVerifying: () => undefined,
}
jest.mock('../src/screens/PasskeyWordsScreen', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return {
    PasskeyWordsScreen: (props: { onDone: () => void; onVerifying: (verifying: boolean) => void }) => {
      mockWords.onDone = props.onDone
      mockWords.onVerifying = props.onVerifying
      return react.createElement(RNText, null, 'WORDS')
    },
  }
})

const PIN = 'com.voltz.wallet.pin'
const SEED = 'com.voltz.wallet.seed'
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type Tree = ReactTestRenderer.ReactTestRenderer

// The native side, from specs/__mocks__: the stamp the leave callback takes on the boot clock, which
// counts sleep and which Settings cannot set, the cover it raises, and the activities the app started.
type Device = {
  clockMs: number
  clockFails: boolean
  leftAt: number | null
  ownLeftAt: number | null
  ownDepth: number
  covered: boolean
  hides: number
  inFront: boolean
  presented: boolean
  dismissals: number
  windowsUp: number
  windowsLeaving: number
  advance: (ms: number) => void
  leave: () => void
  removeWindows: () => void
  endExits: () => void
}
const device: Device = jest.requireMock('../specs/NativeVoltzPrivacy').device
const native: {
  dismissPresented: () => Promise<void>
  takeAway: () => unknown
  beginOwnActivity: () => void
  hideCoverAfterModals: () => void
} = jest.requireMock('../specs/NativeVoltzPrivacy').default

const keychain = new Map<string, string>()
let appListeners: ((state: string) => void)[] = []
// The two JS clocks, which the lock must not read: the wall clock, and performance.now, which on
// Android is CLOCK_MONOTONIC and stands still while the phone sleeps.
let wall = 1_800_000_000_000
let mono = 5_000
let exitApp: jest.SpyInstance
let trees: Tree[] = []

function allText(tree: Tree): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function typePin(tree: Tree, pin: string): Promise<void> {
  for (const digit of pin) {
    const [key] = tree.root.findAll(node => node.props.label === digit && typeof node.props.onPress === 'function')
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  await settle()
}

// Every listener hears the change, as on a device, in one act so the first render after it is checked.
// The state is kept where AppState keeps it, for a reader that asks rather than listens.
async function appState(state: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    setCurrentState(state)
    appListeners.slice().forEach(listener => listener(state))
  })
}

function setCurrentState(state: string): void {
  Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: state })
}

// Time away with the phone awake: every clock moves alike.
function pass(ms: number): void {
  device.advance(ms)
  wall += ms
  mono += ms
}

// A trip away as a device makes it: the native callback stamps and covers, then React Native posts
// 'background', and the return posts 'active', which the lock decides on.
async function away(ms: number): Promise<void> {
  await appState('inactive')
  device.leave()
  await appState('background')
  pass(ms)
  await appState('active')
  await settle()
}

// The lock's first layout, which a device reports once the PIN is drawn. The safe area mock hands its
// props down, so the outermost node is the lock's own.
async function drawLock(tree: Tree): Promise<void> {
  const [lock] = tree.root.findAll(node => node.props.testID === 'lock' && typeof node.props.onLayout === 'function')
  await ReactTestRenderer.act(async () => {
    lock.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 844 } } })
  })
}

const pins = (tree: Tree) => tree.root.findAllByType(PinScreen)
const underLock = (tree: Tree) => tree.root.findByProps({ testID: 'under-lock' }).findByType(View)
const relockLayer = (tree: Tree) =>
  tree.root.findAll(node => node.type === View && node.props.testID === 'relock')

async function boot(): Promise<Tree> {
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  trees.push(tree)
  await settle()
  return tree
}

async function bootAndUnlock(): Promise<Tree> {
  const tree = await boot()
  await typePin(tree, '123456')
  expect(allText(tree)).toContain('NAVIGATOR')
  return tree
}

async function pressForgot(tree: Tree): Promise<void> {
  const forgot = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('pin.forgot')))
  await ReactTestRenderer.act(async () => {
    forgot!.props.onPress()
  })
  await settle()
}

beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  keychain.clear()
  keychain.set(SEED, WORDS)
  keychain.set(PIN, '123456')
  await RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active: 'primary', wallets: [{ id: 'primary', fingerprint: 'fp' }] }),
    'utf8',
  )
  mockNav.mounts = 0
  mockNav.closes = 0
  mockNav.keptAsks = 0
  appListeners = []
  setCurrentState('active')
  jest.mocked(AppState.addEventListener).mockImplementation(((_: string, cb: (state: string) => void) => {
    appListeners.push(cb)
    return { remove: () => appListeners.splice(appListeners.indexOf(cb), 1) }
  }) as never)
  jest.spyOn(Date, 'now').mockImplementation(() => wall)
  jest.spyOn(performance, 'now').mockImplementation(() => mono)
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [...keychain.keys()])
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
  jest.mocked(Keychain.setGenericPassword).mockResolvedValue(false)
  jest.mocked(activeWalletOwingWords).mockResolvedValue(null)
  exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined)
})

// Holds the next read of the PIN itself, and only that read: the keypad reads its count of wrong PINs
// from the Keychain too, before it compares.
function holdPinRead(hold: (resolve: (value: never) => void) => void): void {
  const base = jest.mocked(Keychain.getGenericPassword).getMockImplementation()!
  let held = false
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    if (!held && options?.service === 'com.voltz.wallet.pin') {
      held = true
      return new Promise(hold)
    }
    return base(options)
  })
}

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    trees.forEach(tree => tree.unmount())
  })
  trees = []
  jest.restoreAllMocks()
})

// The time away is the native stamp's alone, on the boot clock.
describe('the clock', () => {
  test('locks at the limit, and not a millisecond before', () => {
    expect(mustLock({ kind: 'away', ms: RELOCK_AFTER_MS - 1 }, true)).toBe(false)
    expect(mustLock({ kind: 'away', ms: RELOCK_AFTER_MS }, true)).toBe(true)
    expect(mustLock({ kind: 'away', ms: 0 }, true)).toBe(false)
  })

  test('a clock that failed locks; a leave the native side did not stamp locks only after a background', () => {
    expect(mustLock({ kind: 'failed' }, false)).toBe(true)
    expect(mustLock({ kind: 'none' }, true)).toBe(true)
    expect(mustLock({ kind: 'unreadable' }, true)).toBe(true)
    expect(mustLock({ kind: 'none' }, false)).toBe(false)
    expect(mustLock({ kind: 'unreadable' }, false)).toBe(false)
  })

  // A trip that began inside the app's own activity has a limit of its own, and either trip at its
  // limit locks.
  test("a trip from inside the app's own activity locks at its own limit, and not a millisecond before", () => {
    expect(mustLock({ kind: 'away', ownMs: RELOCK_AFTER_OWN_MS - 1 }, true)).toBe(false)
    expect(mustLock({ kind: 'away', ownMs: RELOCK_AFTER_OWN_MS }, true)).toBe(true)
    expect(mustLock({ kind: 'away', ownMs: RELOCK_AFTER_OWN_MS }, false)).toBe(true)
    expect(mustLock({ kind: 'away', ms: RELOCK_AFTER_MS, ownMs: 0 }, true)).toBe(true)
    expect(mustLock({ kind: 'away', ms: RELOCK_AFTER_MS - 1, ownMs: RELOCK_AFTER_OWN_MS - 1 }, true)).toBe(false)
  })

  test('reads the codes the native side answers with', () => {
    expect(readAway()).toEqual({ kind: 'none' })
    device.leave()
    device.advance(42_000)
    expect(readAway()).toEqual({ kind: 'away', ms: 42_000 })
    expect(readAway()).toEqual({ kind: 'none' })
    device.ownDepth = 1
    device.leave()
    device.advance(7_000)
    expect(readAway()).toEqual({ kind: 'away', ownMs: 7_000 })
    // Home pressed right after the activity ended, before the return was decided: both trips are kept.
    device.leave()
    device.advance(1_000)
    device.ownDepth = 0
    device.leave()
    device.advance(2_000)
    expect(readAway()).toEqual({ kind: 'away', ms: 2_000, ownMs: 3_000 })
    device.leave()
    device.advance(-1)
    expect(readAway()).toEqual({ kind: 'failed' })
    device.ownDepth = 1
    device.leave()
    device.advance(-1)
    expect(readAway()).toEqual({ kind: 'failed' })
    device.ownDepth = 0
    device.clockFails = true
    device.leave()
    expect(readAway()).toEqual({ kind: 'failed' })
  })

  test('a read that throws or answers no number is unreadable', () => {
    const takeAway = jest.spyOn(native, 'takeAway')
    takeAway.mockImplementationOnce(() => {
      throw new Error('gone')
    })
    expect(readAway()).toEqual({ kind: 'unreadable' })
    takeAway.mockImplementationOnce(() => Number.NaN)
    expect(readAway()).toEqual({ kind: 'unreadable' })
    takeAway.mockImplementationOnce(() => ({ left: -1 }))
    expect(readAway()).toEqual({ kind: 'unreadable' })
    takeAway.mockImplementationOnce(() => ({ left: 5_000, own: Number.NaN }))
    expect(readAway()).toEqual({ kind: 'unreadable' })
  })

  // The real spec, which asks TurboModuleRegistry.get and gets null where no native side exists.
  test('a binary without the module reads as unreadable', () => {
    jest.isolateModules(() => {
      jest.unmock('../specs/NativeVoltzPrivacy')
      const isolated: typeof import('../src/wallet/relock') = require('../src/wallet/relock')
      expect(require('../specs/NativeVoltzPrivacy').default).toBeNull()
      expect(isolated.readAway()).toEqual({ kind: 'unreadable' })
    })
    jest.doMock('../specs/NativeVoltzPrivacy')
  })
})

describe('the clock over a running wallet', () => {
  // Ten minutes away with the CPU asleep, then the date set back nine minutes from Settings: the wall
  // clock and performance.now both read about a minute, and only the boot clock reads ten.
  test('two minutes on the boot clock lock, whatever the wall clock and performance.now say', async () => {
    const tree = await bootAndUnlock()

    device.leave()
    await appState('background')
    device.advance(10 * 60_000)
    wall += 10 * 60_000 - 9 * 60_000
    mono += 60_000
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(1)
  })

  test('a wall clock moved forward adds no time away', async () => {
    const tree = await bootAndUnlock()

    device.leave()
    await appState('background')
    device.advance(1_000)
    wall += 60 * 60_000
    mono += 60 * 60_000
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(0)
  })

  // iOS can suspend the process before JS runs its 'background' handler, and then delivers it on the
  // return, just before 'active'. The stamp was taken when the app left.
  test("a 'background' heard only on the return still counts from the leave", async () => {
    const tree = await bootAndUnlock()

    device.leave()
    pass(RELOCK_AFTER_MS)
    await appState('background')
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(1)
  })

  test('a clock that read zero, or that ran backwards, locks', async () => {
    const tree = await bootAndUnlock()

    device.clockFails = true
    await away(1_000)
    expect(pins(tree)).toHaveLength(1)
    device.clockFails = false
    await drawLock(tree)
    await typePin(tree, '123456')
    expect(pins(tree)).toHaveLength(0)

    device.leave()
    await appState('background')
    device.advance(-5_000)
    await appState('active')
    await settle()
    expect(pins(tree)).toHaveLength(1)
  })

  test('a background the native side never stamped locks', async () => {
    const tree = await bootAndUnlock()

    await appState('background')
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(1)
  })

  test('the app switcher alone, however long, decides nothing', async () => {
    const tree = await bootAndUnlock()

    await appState('inactive')
    pass(10 * RELOCK_AFTER_MS)
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(0)
    expect(allText(tree)).toContain('SHEET CONTENT')
  })

  // The native side keeps the first stamp, so a second leave while away never restarts the clock.
  test('a second leave keeps the first stamp', async () => {
    const tree = await bootAndUnlock()

    device.leave()
    await appState('background')
    pass(RELOCK_AFTER_MS - 1_000)
    device.leave()
    await appState('background')
    pass(1_000)
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(1)
  })

  // Android posts 'active' from onResume and the return is complete only at onPostResume.
  test('waits for the native side to say the app is in front before it decides', async () => {
    const tree = await bootAndUnlock()
    device.inFront = false

    await away(RELOCK_AFTER_MS)
    expect(pins(tree)).toHaveLength(0)
    expect(device.covered).toBe(true)

    device.inFront = true
    await appState('active')
    await settle()
    expect(pins(tree)).toHaveLength(1)
  })
})

// Under two minutes nothing changes but the cover coming down.
describe('a short trip', () => {
  test('asks nothing, closes no sheet, remounts nothing, and lowers the cover', async () => {
    const tree = await bootAndUnlock()
    await ReactTestRenderer.act(async () => {
      tree.root.findByProps({ testID: 'type' }).props.onPress()
    })

    await appState('inactive')
    device.leave()
    await appState('background')
    expect(device.covered).toBe(true)
    // Nothing on the JS side moves while away: the native cover is what hides the app.
    expect(allText(tree)).toContain('SHEET CONTENT')
    expect(allText(tree)).toContain('KEPT SHEET')
    pass(RELOCK_AFTER_MS - 1)
    await appState('active')
    await settle()

    expect(device.covered).toBe(false)
    expect(pins(tree)).toHaveLength(0)
    expect(relockLayer(tree)).toHaveLength(0)
    expect(allText(tree)).toContain('SHEET CONTENT')
    expect(allText(tree)).toContain('KEPT SHEET')
    expect(allText(tree)).toContain('typed:7')
    expect(mockNav.closes).toBe(0)
    expect(mockNav.keptAsks).toBe(0)
    expect(mockNav.mounts).toBe(1)
    expect(underLock(tree).props.pointerEvents).toBe('auto')
    expect(device.dismissals).toBe(0)
  })

  test('lowers the cover over the sheets it keeps on an Android, without waiting for them', async () => {
    const tree = await bootAndUnlock()
    // The two sheets' Dialog windows, which stay on screen under the cover.
    device.windowsUp = 2

    await away(RELOCK_AFTER_MS - 1)

    expect(device.covered).toBe(false)
    expect(allText(tree)).toContain('SHEET CONTENT')
    expect(allText(tree)).toContain('KEPT SHEET')
  })

  test("leaves the lock's own Forgot PIN sheet open", async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    await pressForgot(tree)
    expect(allText(tree)).toContain(i18n.t('pin.forgotTitle'))

    await away(1_000)

    expect(allText(tree)).toContain(i18n.t('pin.forgotTitle'))
    expect(device.covered).toBe(false)
  })
})

// At two minutes the PIN is drawn before the cover comes down, and only then is anything closed.
describe('the lock over a running wallet', () => {
  test('draws the PIN over the wallet, and the cover comes down only once the PIN has laid out', async () => {
    const tree = await bootAndUnlock()
    const hides = device.hides

    await away(RELOCK_AFTER_MS)

    expect(relockLayer(tree)).toHaveLength(1)
    expect(relockLayer(tree)[0].findAllByType(PinScreen)).toHaveLength(1)
    expect(device.covered).toBe(true)
    expect(device.hides).toBe(hides)

    await drawLock(tree)
    expect(device.covered).toBe(false)
    expect(device.hides).toBe(hides + 1)
  })

  test('the cover comes down on its own if the layout never reports, once the PIN is in the tree', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    expect(device.covered).toBe(true)

    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, LIFT_FALLBACK_MS / 2))
    })
    expect(device.covered).toBe(true)
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, LIFT_FALLBACK_MS / 2 + 50))
    })
    expect(pins(tree)).toHaveLength(1)
    expect(device.covered).toBe(false)
  })

  // Android removes a closed Dialog's window after the app lets go of it and plays its exit then, with
  // the theme fixed when the Dialog was made, so a sheet the lock closed would slide out over the PIN
  // once the cover came down.
  test("on Android the cover stays up until the sheets the lock closed have left the screen", async () => {
    const tree = await bootAndUnlock()
    device.windowsUp = 2

    await away(RELOCK_AFTER_MS)
    expect(allText(tree)).not.toContain('SHEET CONTENT')
    expect(allText(tree)).not.toContain('KEPT SHEET')
    await drawLock(tree)

    // Closed in JS by the commit that drew the PIN, and not yet removed by the device.
    expect(device.covered).toBe(true)
    device.removeWindows()
    expect(device.covered).toBe(true)
    device.endExits()
    expect(device.covered).toBe(false)
    expect(pins(tree)).toHaveLength(1)
  })

  // Both native sides drop a hide that finds the app away: it belongs to a return that is over.
  test('a layout that lands after the app left again keeps the cover up until the next return', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    expect(pins(tree)).toHaveLength(1)

    // Home pressed again before the PIN reported its first layout.
    await appState('inactive')
    device.leave()
    device.inFront = false
    await appState('background')
    const hides = device.hides
    await drawLock(tree)
    expect(device.hides).toBe(hides + 1)
    expect(device.covered).toBe(true)

    device.inFront = true
    pass(1_000)
    await appState('active')
    await settle()
    expect(device.covered).toBe(false)
    expect(pins(tree)).toHaveLength(1)
  })

  // The plain hide, which a return under the limit sends, is dropped the same way.
  test('a plain hide that finds the app away keeps the cover up until a hide in front', async () => {
    await bootAndUnlock()
    device.leave()
    device.inFront = false
    const hides = device.hides

    liftCover()
    expect(device.hides).toBe(hides + 1)
    expect(device.covered).toBe(true)

    device.inFront = true
    liftCover()
    expect(device.covered).toBe(false)
  })

  test('a binary without the hide that waits for the Modals still lowers the cover', async () => {
    const tree = await bootAndUnlock()
    jest.spyOn(native, 'hideCoverAfterModals').mockImplementation(() => {
      throw new TypeError('hideCoverAfterModals is not a function')
    })

    await away(RELOCK_AFTER_MS)
    await drawLock(tree)

    expect(device.covered).toBe(false)
    expect(liftCoverAfterModals).not.toThrow()
  })

  test('what iOS presented is dismissed before the PIN is drawn', async () => {
    const tree = await bootAndUnlock()
    device.presented = true
    let pinsAtDismissal = -1
    jest.spyOn(native, 'dismissPresented').mockImplementation(async () => {
      pinsAtDismissal = pins(tree).length
      device.presented = false
    })

    await away(RELOCK_AFTER_MS)

    expect(pinsAtDismissal).toBe(0)
    expect(device.presented).toBe(false)
    expect(pins(tree)).toHaveLength(1)
  })

  test('closes the open sheets, and one its owner keeps stays off the screen until the unlock', async () => {
    const tree = await bootAndUnlock()

    await away(RELOCK_AFTER_MS)
    expect(mockNav.closes).toBe(1)
    expect(mockNav.keptAsks).toBe(1)
    expect(allText(tree)).not.toContain('SHEET CONTENT')
    expect(allText(tree)).not.toContain('KEPT SHEET')

    await drawLock(tree)
    await typePin(tree, '123456')
    expect(allText(tree)).not.toContain('SHEET CONTENT')
    expect(allText(tree)).toContain('KEPT SHEET')
  })

  test('the navigator under it is never remounted, across short trips, lock and unlock', async () => {
    const tree = await bootAndUnlock()
    await ReactTestRenderer.act(async () => {
      tree.root.findByProps({ testID: 'type' }).props.onPress()
    })
    expect(allText(tree)).toContain('typed:7')

    await away(1_000)
    await away(RELOCK_AFTER_MS)
    expect(pins(tree)).toHaveLength(1)
    await drawLock(tree)
    await typePin(tree, '123456')

    expect(pins(tree)).toHaveLength(0)
    expect(allText(tree)).toContain('typed:7')
    expect(mockNav.mounts).toBe(1)
  })

  test('a wrong PIN keeps it locked', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)

    await typePin(tree, '000000')

    expect(pins(tree)).toHaveLength(1)
  })

  test('its own Forgot PIN sheet opens over it', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)

    await pressForgot(tree)

    expect(allText(tree)).toContain(i18n.t('pin.forgotTitle'))
  })

  test('two minutes away from the lock itself keep the cover up until Forgot PIN has left the screen', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    await pressForgot(tree)
    device.windowsUp = 1

    await away(RELOCK_AFTER_MS)

    expect(allText(tree)).not.toContain(i18n.t('pin.forgotTitle'))
    expect(device.covered).toBe(true)
    device.removeWindows()
    device.endExits()
    expect(device.covered).toBe(false)
  })

  test('two minutes away from the lock itself lower the cover with no new layout, and close Forgot PIN', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    await pressForgot(tree)

    await away(RELOCK_AFTER_MS)

    expect(device.covered).toBe(false)
    expect(pins(tree)).toHaveLength(1)
    expect(allText(tree)).not.toContain(i18n.t('pin.forgotTitle'))
  })
})

// While the PIN is up nothing under it takes a touch or says a line.
describe('under the lock', () => {
  test('nothing is touched or reached by a screen reader, and nothing is said until it lifts', async () => {
    const tree = await bootAndUnlock()
    expect(underLock(tree).props.importantForAccessibility).toBe('auto')

    await away(RELOCK_AFTER_MS)
    expect(underLock(tree).props.accessibilityElementsHidden).toBe(true)
    expect(underLock(tree).props.importantForAccessibility).toBe('no-hide-descendants')
    expect(underLock(tree).props.pointerEvents).toBe('none')
    expect(relockLayer(tree)[0].props.accessibilityViewIsModal).toBe(true)

    const announce = jest.mocked(AccessibilityInfo.announceForAccessibility)
    announce.mockClear()
    await ReactTestRenderer.act(async () => {
      mockNav.say('Sent 1,000 sats')
    })
    expect(announce).not.toHaveBeenCalledWith('Sent 1,000 sats')

    await typePin(tree, '123456')
    expect(announce).toHaveBeenCalledWith('Sent 1,000 sats')
    expect(underLock(tree).props.accessibilityElementsHidden).toBe(false)
    expect(underLock(tree).props.pointerEvents).toBe('auto')
  })

  test('back leaves the app and never reaches the screens under it', async () => {
    const tree = await bootAndUnlock()
    // Registered before the lock's, as the navigator's own listener is.
    const reached = jest.fn(() => true)
    const sub = BackHandler.addEventListener('hardwareBackPress', reached)
    await away(RELOCK_AFTER_MS)
    await ReactTestRenderer.act(async () => {
      DeviceEventEmitter.emit('hardwareBackPress', {})
    })
    sub.remove()

    expect(reached).not.toHaveBeenCalled()
    expect(exitApp).toHaveBeenCalledTimes(1)
    expect(pins(tree)).toHaveLength(1)
  })
})

// The app's own prompts and pickers are timed from their start against RELOCK_AFTER_OWN_MS.
describe("the app's own activities", () => {
  test('brackets the activity, and closes the bracket when it throws', async () => {
    let during = -1
    await asOwnActivity(async () => {
      during = device.ownDepth
    })
    expect(during).toBe(1)
    expect(device.ownDepth).toBe(0)

    await expect(
      asOwnActivity(async () => {
        throw new Error('cancelled')
      }),
    ).rejects.toThrow('cancelled')
    expect(device.ownDepth).toBe(0)
  })

  // A pick that ends `ms` after it began, with the pause Android makes under it.
  async function pick(ms: number): Promise<void> {
    let finish!: () => void
    const picking = asOwnActivity(() => new Promise<void>(resolve => (finish = resolve)))
    device.leave()
    expect(device.covered).toBe(false)
    await appState('background')
    pass(ms)
    await ReactTestRenderer.act(async () => {
      finish()
      await picking
    })
    await appState('active')
    await settle()
  }

  test('just under ten minutes in one ask nothing', async () => {
    const tree = await bootAndUnlock()
    await pick(RELOCK_AFTER_OWN_MS - 1)

    expect(pins(tree)).toHaveLength(0)
    expect(allText(tree)).toContain('SHEET CONTENT')
  })

  test('ten minutes from its start lock, as Home pressed inside a picker and a return later', async () => {
    const tree = await bootAndUnlock()
    await pick(RELOCK_AFTER_OWN_MS)
    await drawLock(tree)

    expect(pins(tree)).toHaveLength(1)
    expect(relockLayer(tree)).toHaveLength(1)
  })

  test('an activity whose bracket never closes still leaves every trip timed', async () => {
    const tree = await bootAndUnlock()
    asOwnActivity(() => new Promise<void>(() => undefined)).catch(() => undefined)
    await away(RELOCK_AFTER_OWN_MS - 1)
    expect(pins(tree)).toHaveLength(0)

    await away(RELOCK_AFTER_OWN_MS)
    await drawLock(tree)
    expect(relockLayer(tree)).toHaveLength(1)
  })

  test('a leave from the app right after an activity ended keeps the two minute rule', async () => {
    const tree = await bootAndUnlock()
    let finish!: () => void
    const picking = asOwnActivity(() => new Promise<void>(resolve => (finish = resolve)))
    device.leave()
    await appState('background')
    pass(1_000)
    await ReactTestRenderer.act(async () => {
      finish()
      await picking
    })
    // The return is not decided yet when Home is pressed.
    device.inFront = false
    await appState('active')
    await settle()
    device.inFront = true
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)

    expect(relockLayer(tree)).toHaveLength(1)
  })

  test('the biometric prompt over the lock, answered within ten minutes, never relocks under the unlock it completes', async () => {
    keychain.set('com.voltz.wallet.biometric', '123456')
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    let answer!: () => void
    jest.mocked(Keychain.getGenericPassword).mockImplementationOnce(
      () =>
        new Promise(resolve => {
          // Android pauses the app under the system prompt.
          device.leave()
          answer = () => resolve({ username: 'pin', password: '123456' } as never)
        }),
    )
    const { unlockWithBiometrics } = require('../src/wallet/biometrics')
    const dismissals = device.dismissals
    const unlocking: Promise<boolean> = unlockWithBiometrics('Unlock')
    await appState('background')
    pass(RELOCK_AFTER_OWN_MS - 1)
    await ReactTestRenderer.act(async () => {
      answer()
    })
    expect(await unlocking).toBe(true)
    await appState('active')
    await settle()

    // No second lock ran: every lock first dismisses what iOS presented.
    expect(device.dismissals).toBe(dismissals)
    expect(device.covered).toBe(false)
    expect(device.ownDepth).toBe(0)
    expect(readAway()).toEqual({ kind: 'none' })
  })
})

// Every stage past the first unlock locks, and the boot is as it was.
describe('the steps past the unlock with no navigator', () => {
  test('the biometric offer relocks to the PIN, which then opens the wallet', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID)
    const tree = await boot()
    await typePin(tree, '123456')
    expect(tree.root.findAllByType(BiometricOfferScreen)).toHaveLength(1)

    await away(RELOCK_AFTER_MS)

    expect(tree.root.findAllByType(BiometricOfferScreen)).toHaveLength(0)
    expect(pins(tree)).toHaveLength(1)
    expect(device.covered).toBe(true)
    await drawLock(tree)
    expect(device.covered).toBe(false)

    // The offer was marked as made when it showed, so the PIN leads to the wallet.
    await typePin(tree, '123456')
    expect(pins(tree)).toHaveLength(0)
    expect(allText(tree)).toContain('NAVIGATOR')
  })

  test('a short trip leaves the offer where it was', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID)
    const tree = await boot()
    await typePin(tree, '123456')

    await away(1_000)

    expect(tree.root.findAllByType(BiometricOfferScreen)).toHaveLength(1)
    expect(device.covered).toBe(false)
  })

  // On iOS the write raises no prompt and the native side ignores the bracket, so a leave while it
  // runs is a leave.
  test("an offer's write that answers after the relock opens nothing", async () => {
    jest.spyOn(native, 'beginOwnActivity').mockImplementation(() => undefined)
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID)
    let answer!: () => void
    // The offer's write, not the keypad's count of wrong PINs, which is written first.
    const base = jest.mocked(Keychain.setGenericPassword).getMockImplementation()
    let held = false
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (user, password, options) => {
      if (!held && options?.service !== 'com.voltz.wallet.pin.failures') {
        held = true
        return new Promise(resolve => (answer = () => resolve(false)))
      }
      return base ? base(user, password, options) : false
    })
    const tree = await boot()
    await typePin(tree, '123456')
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(BiometricOfferScreen).props.onEnable().catch(() => undefined)
    })

    await away(RELOCK_AFTER_MS)
    expect(pins(tree)).toHaveLength(1)
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()

    expect(pins(tree)).toHaveLength(1)
    expect(allText(tree)).not.toContain('NAVIGATOR')
  })

  // The words show only behind a typed PIN, as on the recovery phrase screen, so a biometric unlock
  // that lands on owed words asks for the PIN on a keypad that offers no biometric.
  test('a biometric unlock that lands on owed words asks for the typed PIN first', async () => {
    jest.mocked(activeWalletOwingWords).mockResolvedValue('primary')
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID)
    keychain.set('com.voltz.wallet.biometric.currentSet', '123456')
    const tree = await boot()
    // The six dots fill before the biometric unlock hands over.
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1_000))
    })
    await settle()
    expect(allText(tree)).not.toContain('WORDS')
    expect(pins(tree)).toHaveLength(1)
    const reads = jest.mocked(Keychain.getGenericPassword).mock.calls.filter(
      ([options]) => options?.service === 'com.voltz.wallet.biometric.currentSet',
    ).length
    expect(reads).toBe(1)

    await typePin(tree, '123456')
    expect(allText(tree)).toContain('WORDS')
    // The fresh keypad raised no second prompt.
    expect(
      jest.mocked(Keychain.getGenericPassword).mock.calls.filter(
        ([options]) => options?.service === 'com.voltz.wallet.biometric.currentSet',
      ),
    ).toHaveLength(1)
  })

  test('the owed passkey words relock to the PIN, a late answer from them moves nothing, and the PIN leads back to them', async () => {
    jest.mocked(activeWalletOwingWords).mockResolvedValue('primary')
    const tree = await boot()
    await typePin(tree, '123456')
    expect(allText(tree)).toContain('WORDS')
    const { onDone, onVerifying } = mockWords

    await away(RELOCK_AFTER_MS)
    expect(allText(tree)).not.toContain('WORDS')
    expect(pins(tree)).toHaveLength(1)

    await ReactTestRenderer.act(async () => {
      onVerifying(false)
      onDone()
    })
    expect(pins(tree)).toHaveLength(1)
    expect(allText(tree)).not.toContain('WORDS')
    expect(allText(tree)).not.toContain('NAVIGATOR')

    await typePin(tree, '123456')
    expect(allText(tree)).toContain('WORDS')

    jest.mocked(activeWalletOwingWords).mockResolvedValue(null)
    await ReactTestRenderer.act(async () => {
      mockWords.onDone()
    })
    expect(allText(tree)).toContain('NAVIGATOR')
  })

  // The check reads the Keychain, so the app can leave between the last digit and the answer. The
  // native stamp was taken at the leave, before the answer armed the lock.
  test('a PIN whose check answers after the app left still counts the time away', async () => {
    const tree = await boot()
    let check!: () => void
    holdPinRead(resolve => (check = () => resolve({ username: 'u', password: '123456' } as never)))
    await typePin(tree, '123456')
    device.leave()
    await appState('background')

    await ReactTestRenderer.act(async () => {
      check()
    })
    await settle()
    pass(RELOCK_AFTER_MS)
    await appState('active')
    await settle()

    expect(pins(tree)).toHaveLength(1)
    expect(relockLayer(tree)).toHaveLength(1)
  })

  test('an unlock still reading when the lock comes back lands on the PIN', async () => {
    let owing!: (id: string | null) => void
    jest.mocked(activeWalletOwingWords).mockImplementationOnce(() => new Promise(resolve => (owing = resolve)))
    const tree = await boot()
    await typePin(tree, '123456')

    await away(RELOCK_AFTER_MS)
    expect(device.covered).toBe(false)
    await ReactTestRenderer.act(async () => {
      owing(null)
    })
    await settle()

    expect(pins(tree)).toHaveLength(1)
    expect(allText(tree)).not.toContain('NAVIGATOR')
  })

  test('an unlock that finds owed words after the lock came back shows no words', async () => {
    let owing!: (id: string | null) => void
    jest.mocked(activeWalletOwingWords).mockImplementationOnce(() => new Promise(resolve => (owing = resolve)))
    const tree = await boot()
    await typePin(tree, '123456')

    await away(RELOCK_AFTER_MS)
    await ReactTestRenderer.act(async () => {
      owing('primary')
    })
    await settle()

    expect(pins(tree)).toHaveLength(1)
    expect(allText(tree)).not.toContain('WORDS')
  })
})

// A PIN or biometric answers after a read of its own, which can land after the app left and a newer
// lock was drawn. Each lock draws its own keypad, and an answer opens only the lock it was given to.
describe('an answer given to an older lock', () => {
  // Holds the next PIN check, as a Keychain read still running when the app leaves.
  function holdCheck(): () => void {
    let check!: () => void
    holdPinRead(resolve => (check = () => resolve({ username: 'u', password: '123456' } as never)))
    return () => check()
  }

  test('a PIN typed on the lock over the wallet and checked after a newer lock opens nothing', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    const check = holdCheck()
    await typePin(tree, '123456')
    expect(relockLayer(tree)).toHaveLength(1)

    await away(RELOCK_AFTER_MS)
    await ReactTestRenderer.act(async () => {
      check()
    })
    await settle()

    expect(relockLayer(tree)).toHaveLength(1)
    expect(pins(tree)).toHaveLength(1)
    // The newer lock's own keypad still opens it.
    await typePin(tree, '123456')
    expect(relockLayer(tree)).toHaveLength(0)
  })

  test('a PIN typed on the lock that replaced the biometric offer and checked after a newer lock opens nothing', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID)
    const tree = await boot()
    await typePin(tree, '123456')
    expect(tree.root.findAllByType(BiometricOfferScreen)).toHaveLength(1)
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    const check = holdCheck()
    await typePin(tree, '123456')

    await away(RELOCK_AFTER_MS)
    await ReactTestRenderer.act(async () => {
      check()
    })
    await settle()

    expect(allText(tree)).not.toContain('NAVIGATOR')
    expect(tree.root.findAllByType(BiometricOfferScreen)).toHaveLength(0)
    expect(pins(tree)).toHaveLength(1)
  })

  // The boot's PIN arms the lock when it opens; an answer that lands after Forgot PIN erased everything
  // must not arm it over the first run, where no PIN exists to open it.
  test("a boot PIN checked after Forgot PIN's erase arms nothing over Welcome", async () => {
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(false)
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
    const tree = await boot()
    const check = holdCheck()
    await typePin(tree, '123456')
    await pressForgot(tree)
    const [erase] = tree.root.findAll(
      node => node.props.label === i18n.t('pin.forgotErase') && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      erase.props.onPress()
    })
    await settle()
    expect(allText(tree)).toContain(i18n.t('welcome.title'))

    await ReactTestRenderer.act(async () => {
      check()
    })
    await settle()
    await away(RELOCK_AFTER_MS)

    expect(pins(tree)).toHaveLength(0)
    expect(allText(tree)).toContain(i18n.t('welcome.title'))
  })

  test('a check that answers before any newer lock still opens the wallet', async () => {
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    const check = holdCheck()
    await typePin(tree, '123456')
    await away(RELOCK_AFTER_MS - 1)
    await ReactTestRenderer.act(async () => {
      check()
    })
    await settle()

    expect(relockLayer(tree)).toHaveLength(0)
  })
})

// Forgot PIN on the lock over a running wallet. The navigator under it holds Home, whose reads connect
// the SDK, so it comes down before the erase begins.
describe('Forgot PIN over a running wallet', () => {
  test('takes the navigator down and draws no keypad while the erase runs, and no connect starts', async () => {
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(false)
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    await pressForgot(tree)

    // The erase's first Keychain listing waits until the test has looked.
    let listed!: () => void
    const listing = new Promise<void>(resolve => (listed = resolve))
    const list = jest.mocked(Keychain.getAllGenericPasswordServices).getMockImplementation()!
    jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementationOnce(async () => {
      await listing
      return list()
    })
    const [erase] = tree.root.findAll(
      node => node.props.label === i18n.t('pin.forgotErase') && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      erase.props.onPress()
    })
    await settle()

    expect(allText(tree)).not.toContain('NAVIGATOR')
    expect(relockLayer(tree)).toHaveLength(0)
    expect(pins(tree)).toHaveLength(0)
    const { SparkConnectSuperseded, connectActiveSpark } = require('../src/wallet/spark')
    await expect(connectActiveSpark()).rejects.toBeInstanceOf(SparkConnectSuperseded)

    await ReactTestRenderer.act(async () => {
      listed()
    })
    await settle()
    expect(keychain.has(SEED)).toBe(false)
    expect(allText(tree)).not.toContain('NAVIGATOR')
  })

  test('an erase that fails leaves the lock with its keypad and the sheet with its error', async () => {
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(false)
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await bootAndUnlock()
    await away(RELOCK_AFTER_MS)
    await drawLock(tree)
    await pressForgot(tree)
    jest.mocked(Keychain.getAllGenericPasswordServices).mockRejectedValueOnce(new Error('locked'))
    const [erase] = tree.root.findAll(
      node => node.props.label === i18n.t('pin.forgotErase') && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      erase.props.onPress()
    })
    await settle()

    expect(allText(tree)).toContain(i18n.t('pin.forgotFailed'))
    expect(allText(tree)).not.toContain('NAVIGATOR')
    expect(pins(tree)).toHaveLength(1)
  })
})

describe('the boot', () => {
  test('locks as before, and time away before the first unlock locks nothing and lowers the cover', async () => {
    const tree = await boot()
    expect(pins(tree)).toHaveLength(1)
    expect(tree.root.findAllByProps({ testID: 'under-lock' })).toHaveLength(0)

    await away(10 * RELOCK_AFTER_MS)
    expect(device.covered).toBe(false)
    expect(pins(tree)).toHaveLength(1)
    expect(relockLayer(tree)).toHaveLength(0)

    await typePin(tree, '123456')
    expect(pins(tree)).toHaveLength(0)
    expect(allText(tree)).toContain('NAVIGATOR')
    expect(mockNav.mounts).toBe(1)
  })

  test('a cover raised before the app mounted comes down on the first decision', async () => {
    device.leave()
    pass(1_000)
    const tree = await boot()

    expect(device.covered).toBe(false)
    expect(pins(tree)).toHaveLength(1)
  })

  test('a first run is armed once its PIN is set, not before', async () => {
    keychain.delete(PIN)
    const tree = await boot()
    expect(tree.root.findAllByType(PinScreen)[0].props.mode).toBe('set')

    await away(10 * RELOCK_AFTER_MS)
    expect(tree.root.findAllByType(PinScreen)[0].props.mode).toBe('set')

    // Typed, then typed again to confirm.
    await typePin(tree, '123456')
    await typePin(tree, '123456')
    expect(allText(tree)).toContain('NAVIGATOR')

    await away(RELOCK_AFTER_MS)
    expect(pins(tree)).toHaveLength(1)
  })
})

// Each Modal is a window over the app's own view, so the lock drawn there sits under it. A Modal that
// does not close on the lock, or that its owner keeps visible under it, would show over it. So a file
// asks useCloseOnLock once for each Modal it renders, and every Modal's visible reads what one returns.
test('every Modal in src closes when the lock lands, and stays off the screen under it', () => {
  const files = walk(`${__dirname}/../src`).filter(file => /\.tsx$/.test(file))
  const modals = files.filter(file => /<Modal\b/.test(RNFSActual(file)))
  expect(modals.length).toBeGreaterThan(0)
  for (const file of modals) {
    const source = RNFSActual(file)
    const visibles = modalVisibles(source)
    const asks = source.match(/useCloseOnLock\(/g)?.length ?? 0
    expect([file, asks >= visibles.length]).toEqual([file, true])
    const locks = [...source.matchAll(/const (\w+) = useCloseOnLock\(/g)].map(match => match[1])
    for (const visible of visibles) {
      const hidden = visible !== null && locks.some(name => new RegExp(`!${name}\\b`).test(visible))
      expect([file, visible, hidden]).toEqual([file, visible, true])
    }
  }
})

// What each <Modal's visible reads, or null for one that sets none and so always shows. The opening
// tag ends at the first '>' outside any expression.
function modalVisibles(source: string): (string | null)[] {
  return [...source.matchAll(/<Modal\b/g)].map(match => {
    let depth = 0
    let start = -1
    for (let at = match.index! + '<Modal'.length; at < source.length; at++) {
      if (depth === 0 && source[at] === '>') {
        return null
      }
      if (depth === 0 && /\s/.test(source[at - 1]) && source.startsWith('visible={', at)) {
        start = at + 'visible={'.length
      }
      if (source[at] === '{') {
        depth += 1
      } else if (source[at] === '}') {
        depth -= 1
        if (depth === 0 && start >= 0) {
          return source.slice(start, at)
        }
      }
    }
    return null
  })
}

function RNFSActual(file: string): string {
  return jest.requireActual('fs').readFileSync(file, 'utf8')
}

function walk(dir: string): string[] {
  const fs = jest.requireActual('fs')
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: { name: string; isDirectory: () => boolean }) =>
    entry.isDirectory() ? walk(`${dir}/${entry.name}`) : [`${dir}/${entry.name}`],
  )
}

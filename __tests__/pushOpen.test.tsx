import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Platform } from 'react-native'
import {
  getInitialNotification,
  getMessaging,
  onMessage,
  onNotificationOpenedApp,
  type RemoteMessage,
} from '@react-native-firebase/messaging'
import App from '../App'
import { RootNavigator } from '../src/navigation/RootNavigator'
import { routePushNotification, setPushHandler, type PushDestination } from '../src/wallet/pushRoute'
import { hasPin } from '../src/wallet/pin'

// The container renders no children, which keeps this file on the wiring under test (the effect,
// the allowlist, the stash and the ready drain) instead of the whole screen tree. `onReady` is held
// rather than fired, so a test decides whether the tap arrives before it or after.
const mockNavigate = jest.fn()
const mockReady = { value: false }
const mockOnReady: { current: (() => void) | null } = { current: null }
const mockNavRef = {
  isReady: () => mockReady.value,
  navigate: mockNavigate,
  getCurrentRoute: () => undefined,
}
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigationContainerRef: () => mockNavRef,
  NavigationContainer: ({ onReady }: { onReady: () => void }) => {
    mockOnReady.current = onReady
    return null
  },
}))

// Subscribes to the SDK and draws over the navigator; nothing here depends on it.
jest.mock('../src/components/ReceivedOverlayHost', () => ({ ReceivedOverlayHost: () => null }))

// A wallet exists, so boot lands on 'ready' or 'locked' rather than on welcome.
jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  settleActiveWallet: jest.fn(async () => true),
}))
jest.mock('../src/wallet/pin', () => ({
  ...jest.requireActual('../src/wallet/pin'),
  hasPin: jest.fn(async () => false),
}))

const mockUnsubscribe = jest.fn()
const mockUnsubscribeArrivals = jest.fn()
// onMessage is here because the effect calls it, and a double that does not answer throws inside
// the try that wraps the whole thing, which takes the taps down with it and reads as the taps being
// broken. The two unsubscribes are separate so a test can tell which listener was dropped.
jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(() => ({})),
  getInitialNotification: jest.fn(async () => null),
  onNotificationOpenedApp: jest.fn(() => mockUnsubscribe),
  onMessage: jest.fn(() => mockUnsubscribeArrivals),
  getToken: jest.fn(async () => 'fcm-token'),
  onTokenRefresh: jest.fn(() => () => undefined),
}))

const REAL_OS = Platform.OS

function setPlatform(os: string) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
}

// Builds the shape FCM delivers, where the routing fields live under `data` and never on the
// message itself.
function tap(data: unknown): RemoteMessage {
  return { data } as unknown as RemoteMessage
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

// A wallet with no PIN boots into Create PIN, so the PIN is set, twice on the keypad, before the
// navigator mounts. A locked wallet is left on its lock.
async function boot(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  await settle()
  if (!(await hasPin())) {
    for (const digit of '123456123456') {
      const [key] = tree.root.findAll(
        node => node.props.label === digit && typeof node.props.onPress === 'function',
      )
      await ReactTestRenderer.act(async () => {
        key.props.onPress()
      })
    }
    await settle()
  }
  return tree
}

function openedListener(): (message: RemoteMessage | null) => void {
  const calls = jest.mocked(onNotificationOpenedApp).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][1] as (message: RemoteMessage | null) => void
}

const messagingStub = {} as ReturnType<typeof getMessaging>

beforeEach(() => {
  jest.clearAllMocks()
  // Draining first stops a destination stashed by one test from arriving in the next.
  setPushHandler(() => undefined)
  setPushHandler(null)
  setPlatform('android')
  mockReady.value = true
  mockOnReady.current = null
  // clearAllMocks empties the call record and leaves the implementation, so a stub set by one test
  // would otherwise follow the suite around.
  jest.mocked(getMessaging).mockReturnValue(messagingStub)
  jest.mocked(getInitialNotification).mockResolvedValue(null)
  jest.mocked(onNotificationOpenedApp).mockReturnValue(mockUnsubscribe)
  jest.mocked(onMessage).mockReturnValue(mockUnsubscribeArrivals)
  jest.mocked(hasPin).mockResolvedValue(false)
})

afterEach(() => {
  setPlatform(REAL_OS)
})

describe('the tap that started the process', () => {
  it('opens the one destination the allowlist names, once', async () => {
    jest
      .mocked(getInitialNotification)
      .mockResolvedValue(tap({ type: 'domain', host: 'pay.bakery.com.br', stage: '4' }))

    await boot()

    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress')
  })

  it('navigates nowhere when the app was opened from its icon', async () => {
    jest.mocked(getInitialNotification).mockResolvedValue(null)

    await boot()

    expect(getInitialNotification).toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('navigates nowhere for a payload naming a screen of its own', async () => {
    jest
      .mocked(getInitialNotification)
      .mockResolvedValue(tap({ type: 'Send', screen: 'Send', params: { destination: 'lnbc1' } }))

    await boot()

    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('survives a read that rejects, since the boot cannot depend on it', async () => {
    jest.mocked(getInitialNotification).mockRejectedValue(new Error('no play services'))

    await boot()

    // The navigator still mounted, so the failure stayed inside the effect.
    expect(mockOnReady.current).not.toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

describe('the tap that brought the app forward', () => {
  it('opens the destination the allowlist names', async () => {
    await boot()

    ReactTestRenderer.act(() => openedListener()(tap({ type: 'domain', stage: '5' })))

    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress')
  })

  it('does nothing, and never throws, on a message it cannot read', async () => {
    await boot()
    const opened = openedListener()

    // A throw inside the handler is a crash on open, and every one of these can arrive from the
    // network.
    expect(() => opened(null)).not.toThrow()
    expect(() => opened({} as RemoteMessage)).not.toThrow()
    expect(() => opened(tap(undefined))).not.toThrow()
    expect(() => opened(tap(null))).not.toThrow()
    expect(() => opened(tap('domain'))).not.toThrow()
    expect(() => opened(tap({ type: 'Send' }))).not.toThrow()

    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('reads the routing fields off `data`, where FCM puts them', async () => {
    await boot()
    const opened = openedListener()

    // A type sitting on the message itself is not a payload, and the payload is not read from the
    // message: a sender who could get either half wrong must not be able to route the app.
    ReactTestRenderer.act(() => opened({ type: 'domain' } as unknown as RemoteMessage))
    expect(mockNavigate).not.toHaveBeenCalled()

    ReactTestRenderer.act(() =>
      opened({ data: { type: 'domain' }, type: 'Send' } as unknown as RemoteMessage),
    )
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress')
  })

  it('stops listening when the app goes away, so a second mount does not route twice', async () => {
    const tree = await boot()

    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    // Both listeners, not just the tap one. The effect returns a single teardown now, and dropping
    // either line inside it leaves a listener attached to a torn-down tree.
    expect(mockUnsubscribeArrivals).toHaveBeenCalledTimes(1)
  })
})

// pushRoute is exercised on its own in pushRoute.test.ts. What only this file can prove is the
// composed path: a payload off the network, through the effect, through the table, into navigate.
const NUL = String.fromCharCode(0)
const HOSTILE: unknown[] = [
  { type: 'Send', screen: 'Send', params: { destination: 'lnbc1' } },
  { type: 'LnAddress' },
  { type: 'Main' },
  { type: '../Send' },
  { type: 'Main/Send' },
  { type: 'domain ' },
  { type: ' domain' },
  { type: 'Domain' },
  { type: 'DOMAIN' },
  { type: `domain${NUL}` },
  { type: 'domain\n' },
  { type: '__proto__' },
  { type: 'constructor' },
  { type: 'toString' },
  { type: { toString: () => 'domain' } },
  { type: ['domain'] },
  { type: 4 },
  { type: true },
  { type: null },
  { type: 'a'.repeat(500_000) },
  {},
  { screen: 'Send' },
  { navigate: 'Send', route: 'Send' },
  JSON.parse('{"__proto__":{"type":"domain"}}'),
  undefined,
  null,
  'domain',
  4,
  ['domain'],
]

describe('what a sender who can reach this device can make it do', () => {
  it('cannot move the app anywhere the table does not name', async () => {
    await boot()
    const opened = openedListener()

    for (const payload of HOSTILE) {
      mockNavigate.mockClear()
      ReactTestRenderer.act(() => opened(tap(payload)))
      expect({ payload, calls: mockNavigate.mock.calls }).toEqual({ payload, calls: [] })
    }
  })

  it('cannot attach params to the one destination it can reach', async () => {
    await boot()
    const opened = openedListener()

    // Every field a sender controls is set to something that would route or parametrise if any of
    // it were read. navigate takes the table's word and nothing else, so it takes one argument.
    ReactTestRenderer.act(() =>
      opened({
        data: { type: 'domain', screen: 'Send', params: '{"destination":"lnbc1"}', host: 'x' },
        screen: 'Send',
        params: { destination: 'lnbc1' },
      } as unknown as RemoteMessage),
    )

    expect(mockNavigate.mock.calls).toEqual([['LnAddress']])
  })
})

// The listeners run on iOS as they do on Android, so a payload that reaches an iPhone meets the same
// table and nothing else.
describe('iOS', () => {
  beforeEach(() => {
    setPlatform('ios')
  })

  it('opens the destination the allowlist names from the tap that started the process', async () => {
    jest
      .mocked(getInitialNotification)
      .mockResolvedValue(tap({ type: 'domain', host: 'pay.bakery.com.br', stage: '4' }))

    await boot()

    expect(getMessaging).toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress')
  })

  it('opens the destination the allowlist names from a tap that brings the app forward', async () => {
    await boot()

    ReactTestRenderer.act(() => openedListener()(tap({ type: 'domain', stage: '5' })))

    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress')
  })

  it('listens for arrivals while the app is in front', async () => {
    await boot()

    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('cannot be moved anywhere the table does not name', async () => {
    await boot()
    const opened = openedListener()

    for (const payload of HOSTILE) {
      mockNavigate.mockClear()
      ReactTestRenderer.act(() => opened(tap(payload)))
      expect({ payload, calls: mockNavigate.mock.calls }).toEqual({ payload, calls: [] })
    }
    expect(() => opened(null)).not.toThrow()
    expect(() => opened({} as RemoteMessage)).not.toThrow()
  })

  it('cannot attach params to the one destination it can reach', async () => {
    await boot()

    ReactTestRenderer.act(() =>
      openedListener()({
        data: { type: 'domain', screen: 'Send', params: '{"destination":"lnbc1"}', host: 'x' },
        screen: 'Send',
        params: { destination: 'lnbc1' },
      } as unknown as RemoteMessage),
    )

    expect(mockNavigate.mock.calls).toEqual([['LnAddress']])
  })

  it('stops listening when the app goes away', async () => {
    const tree = await boot()

    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })

    expect(mockUnsubscribe).toHaveBeenCalledTimes(1)
    expect(mockUnsubscribeArrivals).toHaveBeenCalledTimes(1)
  })

  it('still mounts the app when the messaging module throws at boot', async () => {
    ;(getMessaging as jest.Mock).mockImplementationOnce(() => {
      throw new Error('no native module')
    })
    const tree = await boot()
    expect(tree.toJSON()).not.toBeNull()
  })
})

describe('a tap on a locked app', () => {
  it('waits for the PIN, because the navigator that routes it is not mounted', async () => {
    jest.mocked(hasPin).mockResolvedValue(true)
    jest.mocked(getInitialNotification).mockResolvedValue(tap({ type: 'domain' }))

    await boot()

    // The navigator is the only thing that registers a handler, and it mounts at stage 'ready'.
    expect(mockOnReady.current).toBeNull()
    expect(mockNavigate).not.toHaveBeenCalled()

    // Nothing is lost, since the first handler to register gets it, and only the first.
    const seen: PushDestination[] = []
    setPushHandler(destination => seen.push(destination))
    expect(seen).toEqual(['LnAddress'])
    setPushHandler(destination => seen.push(destination))
    expect(seen).toEqual(['LnAddress'])
  })
})

describe('the navigator, before it is ready', () => {
  it('stashes the tap and drains it once, when the container becomes ready', async () => {
    mockReady.value = false
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(<RootNavigator />)
    })

    routePushNotification({ type: 'domain', host: 'pay.bakery.com.br' })
    expect(mockNavigate).not.toHaveBeenCalled()

    mockReady.value = true
    ReactTestRenderer.act(() => mockOnReady.current?.())
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress')

    // A container that becomes ready again must not repeat a tap already acted on.
    ReactTestRenderer.act(() => mockOnReady.current?.())
    expect(mockNavigate).toHaveBeenCalledTimes(1)
  })

  it('hands a tap arriving after it unmounts to the next navigator, not to itself', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<RootNavigator />)
    })
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })

    routePushNotification({ type: 'domain' })
    expect(mockNavigate).not.toHaveBeenCalled()

    const seen: PushDestination[] = []
    setPushHandler(destination => seen.push(destination))
    expect(seen).toEqual(['LnAddress'])
  })

  it('still mounts the app when the messaging module throws at boot', async () => {
    // Notification routing is not worth the wallet. Without the guard the throw leaves the effect
    // and nothing mounts, locking somebody out over a feature they were not using.
    ;(getMessaging as jest.Mock).mockImplementationOnce(() => {
      throw new Error('no native module')
    })
    const tree = await boot()
    expect(tree.toJSON()).not.toBeNull()
  })
})

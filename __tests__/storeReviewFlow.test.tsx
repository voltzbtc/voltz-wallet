import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Text } from 'react-native'
import RNFS from 'react-native-fs'
import { RootNavigator } from '../src/navigation/RootNavigator'
import { UnderLock } from '../src/components/UnderLock'
import { Sheet } from '../src/components/Sheet'
import { ReceivedOverlay } from '../src/components/ReceivedOverlay'
import { __resetStoreReviewForTests } from '../src/wallet/storeReview'
import { notePendingSend } from '../src/wallet/pendingSends'
import type { ReceiveUpdate } from '../src/wallet/spark'

// The whole path from an SDK receive to the store's card: the real RootNavigator, ReceivedOverlayHost,
// UnderLock, Sheet and storeReview. The container renders nothing, and the ref answers the route the
// test puts in front, in the shape the real navigators give (homeInFront.test.tsx holds that shape),
// with the leave from Receive landing on Home.

const { reviewStore } = jest.requireMock('../specs/NativeVoltzReview') as {
  reviewStore: { calls: number; fails: (code: string) => void }
}

// The real overlay animates through worklets that do not run under Jest (jest.setup.js draws it as
// nothing). This one is what it is to the ask: a Modal that registers through useCloseOnLock while
// visible and closes when the lock lands, as ReceivedOverlay does.
jest.mock('../src/components/ReceivedOverlay', () => {
  const react = require('react')
  const rn = require('react-native')
  const { useCloseOnLock } = require('../src/components/UnderLock')
  return {
    ReceivedOverlay: ({ visible, onDone }: { visible: boolean; onDone: () => void }) => {
      const locked = useCloseOnLock(visible, onDone)
      return react.createElement(rn.Modal, { visible: visible && !locked, transparent: true }, null)
    },
  }
})

const mockNav = { route: 'Home', drawerOpen: false }

function mockStateOf(route: string, drawerOpen: boolean): unknown {
  const main = {
    name: 'Main',
    state: {
      index: 0,
      routes: [
        {
          name: 'Tabs',
          state: { index: route === 'History' ? 0 : 1, routes: [{ name: 'History' }, { name: 'Home' }] },
        },
      ],
      history: drawerOpen ? [{ type: 'route' }, { type: 'drawer', status: 'open' }] : [{ type: 'route' }],
      default: 'closed',
    },
  }
  return route === 'Home' || route === 'History'
    ? { index: 0, routes: [main] }
    : { index: 1, routes: [main, { name: route }] }
}

const mockRef = {
  isReady: () => true,
  getCurrentRoute: () => ({ name: mockNav.route }),
  getRootState: () => mockStateOf(mockNav.route, mockNav.drawerOpen),
  dispatch: (action: { type: string }) => {
    if (action.type === 'POP_TO') {
      mockNav.route = 'Home'
    }
  },
  navigate: jest.fn(),
}
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigationContainerRef: () => mockRef,
  NavigationContainer: () => null,
}))

const mockSpark = {
  wallet: 'w_a' as string | null,
  spending: false,
  connects: [] as Array<() => void>,
  show: null as ((update: ReceiveUpdate) => void) | null,
}
jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  onSparkConnected: (cb: () => void) => {
    mockSpark.connects.push(cb)
    return () => {
      mockSpark.connects = mockSpark.connects.filter(c => c !== cb)
    }
  },
  sparkSubscribeToReceives: async (show: (update: ReceiveUpdate) => void) => {
    mockSpark.show = show
    return () => undefined
  },
  sparkGetFiatRates: async () => ({}),
  sparkGetPayment: jest.fn(),
  sparkListFiatCurrencies: async () => [],
  sparkConnectedWalletId: () => mockSpark.wallet,
  sparkSpendInFlight: () => mockSpark.spending,
}))

const setAppState = (state: string): void => {
  Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: state })
}

const listWallets = (ids: string[], active: string): Promise<void> =>
  RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active, wallets: ids.map(id => ({ id, fingerprint: `fp-${id}` })) }),
    'utf8',
  )

function OpenSheet(): React.JSX.Element {
  return (
    <Sheet visible onClose={() => undefined} closeLabel="close">
      <Text>sheet</Text>
    </Sheet>
  )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

let tree: ReactTestRenderer.ReactTestRenderer | null = null

async function mount(options: { locked?: boolean; sheet?: boolean } = {}): Promise<void> {
  const draw = (locked: boolean, sheet: boolean) => (
    <UnderLock locked={locked}>
      <RootNavigator />
      {sheet ? <OpenSheet /> : null}
    </UnderLock>
  )
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(draw(options.locked ?? false, options.sheet ?? false))
  })
  await ReactTestRenderer.act(async () => {
    mockSpark.connects.forEach(cb => cb())
  })
  await settle()
  expect(mockSpark.show).not.toBeNull()
}

async function redraw(options: { locked?: boolean; sheet?: boolean }): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree!.update(
      <UnderLock locked={options.locked ?? false}>
        <RootNavigator />
        {options.sheet ? <OpenSheet /> : null}
      </UnderLock>,
    )
  })
  await settle()
}

let payments = 0
async function receive(stage: ReceiveUpdate['stage'] = 'received'): Promise<void> {
  payments += 1
  await ReactTestRenderer.act(async () => {
    mockSpark.show!({ id: `pay-${payments}`, stage, sat: 2100 })
  })
  await settle()
}

const overlayUp = (): boolean => tree!.root.findAllByType(ReceivedOverlay).length > 0

async function closeOverlay(): Promise<void> {
  const overlay = tree!.root.findByType(ReceivedOverlay)
  await ReactTestRenderer.act(async () => {
    overlay.props.onDone()
  })
  await settle()
}

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __resetStoreReviewForTests()
  mockNav.route = 'Home'
  mockNav.drawerOpen = false
  mockSpark.wallet = 'w_a'
  mockSpark.spending = false
  mockSpark.connects = []
  mockSpark.show = null
  setAppState('active')
  await listWallets(['w_a', 'w_b'], 'w_a')
})

afterEach(async () => {
  jest.restoreAllMocks()
  if (tree) {
    await ReactTestRenderer.act(async () => tree!.unmount())
    tree = null
  }
})

test('asks once, on Home, after the overlay of a completed receive closes, and never again', async () => {
  await mount()

  await receive()
  expect(overlayUp()).toBe(true)
  expect(reviewStore.calls).toBe(0)
  await closeOverlay()
  expect(reviewStore.calls).toBe(1)

  await receive()
  await closeOverlay()
  expect(reviewStore.calls).toBe(1)
})

test('asks after the close leaves Receive for Home', async () => {
  mockNav.route = 'Receive'
  await mount()

  await receive()
  await closeOverlay()

  expect(mockNav.route).toBe('Home')
  expect(reviewStore.calls).toBe(1)
})

test('a receive that lands during a send asks nothing, and the next one on Home asks', async () => {
  mockNav.route = 'Send'
  await mount()

  await receive()
  await closeOverlay()
  expect(reviewStore.calls).toBe(0)

  // Back on Home with nothing new announced, nothing asks.
  mockNav.route = 'Home'
  await redraw({})
  expect(reviewStore.calls).toBe(0)

  await receive()
  await closeOverlay()
  expect(reviewStore.calls).toBe(1)
})

test.each(['Convert', 'Scan', 'Redeem'])('asks nothing with %s in front', async route => {
  mockNav.route = route
  await mount()

  await receive()
  await closeOverlay()

  expect(reviewStore.calls).toBe(0)
})

test('asks nothing while a sheet is open on Home', async () => {
  await mount({ sheet: true })

  await receive()
  await closeOverlay()

  expect(reviewStore.calls).toBe(0)
})

test('asks nothing with the drawer open', async () => {
  mockNav.drawerOpen = true
  await mount()

  await receive()
  await closeOverlay()

  expect(reviewStore.calls).toBe(0)
})

test('asks nothing while a send is in flight, or a send is left pending', async () => {
  await mount()
  mockSpark.spending = true
  await receive()
  await closeOverlay()
  expect(reviewStore.calls).toBe(0)

  mockSpark.spending = false
  await notePendingSend('w_a', 'pay-out')
  await receive()
  await closeOverlay()
  expect(reviewStore.calls).toBe(0)
})

test('asks nothing when the PIN asked again closes the overlay', async () => {
  await mount()
  await receive()
  expect(overlayUp()).toBe(true)

  // The lock closes every Modal through useCloseOnLock, the overlay included.
  await redraw({ locked: true })
  expect(overlayUp()).toBe(false)
  expect(reviewStore.calls).toBe(0)

  await redraw({ locked: false })
  expect(reviewStore.calls).toBe(0)
})

test('asks nothing while the app is away', async () => {
  await mount()
  setAppState('background')

  await receive()
  await closeOverlay()

  expect(reviewStore.calls).toBe(0)
})

test('asks nothing for a pending or a failed receive', async () => {
  await mount()

  await receive('incoming')
  await receive('failed')

  expect(overlayUp()).toBe(false)
  expect(reviewStore.calls).toBe(0)
})

test('asks nothing for a receive on a wallet that is no longer the active one', async () => {
  mockSpark.wallet = 'w_b'
  await mount()

  await receive()
  await closeOverlay()

  expect(reviewStore.calls).toBe(0)
})

test('a store that fails is silent and the wallet is not asked again', async () => {
  const said = [
    jest.spyOn(console, 'warn').mockImplementation(() => undefined),
    jest.spyOn(console, 'error').mockImplementation(() => undefined),
  ]
  reviewStore.fails('play-2')
  await mount()

  await receive()
  await closeOverlay()
  await receive()
  await closeOverlay()

  expect(reviewStore.calls).toBe(1)
  said.forEach(spy => expect(spy).not.toHaveBeenCalled())
})

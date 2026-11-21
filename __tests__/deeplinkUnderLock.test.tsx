import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Text } from 'react-native'
import '../src/i18n'
import { RootNavigator } from '../src/navigation/RootNavigator'
import { UnderLock } from '../src/components/UnderLock'
import { useRelock } from '../src/hooks/useRelock'
import { RELOCK_AFTER_MS, RELOCK_AFTER_OWN_MS, asOwnActivity } from '../src/wallet/relock'
import { routeLightningUrl, setDeeplinkHandler, settleDeeplinkHold } from '../src/wallet/deeplink'

const mockNavigate = jest.fn()

// The container is never drawn, so mounting the navigator exercises only its wiring to the outside:
// what a link does depends on whether the PIN is over it, not on the screens behind it.
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigationContainerRef: () => ({
    isReady: () => true,
    navigate: mockNavigate,
    getCurrentRoute: () => undefined,
  }),
  NavigationContainer: () => null,
}))
jest.mock('../src/components/ReceivedOverlayHost', () => ({ ReceivedOverlayHost: () => null }))

function app(locked: boolean): React.JSX.Element {
  return (
    <UnderLock locked={locked}>
      <RootNavigator />
    </UnderLock>
  )
}

let tree: ReactTestRenderer.ReactTestRenderer | null = null

function mount(locked: boolean): void {
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(app(locked))
  })
}

function lock(locked: boolean): void {
  ReactTestRenderer.act(() => tree!.update(app(locked)))
}

beforeEach(() => mockNavigate.mockClear())

afterEach(() => {
  ReactTestRenderer.act(() => tree?.unmount())
  tree = null
  // Drains anything a test left stashed or held, so it cannot reach the next one.
  settleDeeplinkHold(false)
  setDeeplinkHandler(() => undefined)
  setDeeplinkHandler(null)
})

it('opens Send for a link that arrives with the wallet unlocked', () => {
  mount(false)
  ReactTestRenderer.act(() => routeLightningUrl('lightning:lnbc1open'))
  expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1open' }]])
})

it('opens nothing for a link that arrives under the PIN, and opens it once after the unlock', () => {
  mount(false)
  lock(true)
  ReactTestRenderer.act(() => routeLightningUrl('lightning:lnbc1locked'))
  expect(mockNavigate).not.toHaveBeenCalled()

  lock(false)
  expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1locked' }]])

  lock(true)
  lock(false)
  expect(mockNavigate).toHaveBeenCalledTimes(1)
})

it('holds a link through a navigator mounted under the PIN', () => {
  mount(true)
  ReactTestRenderer.act(() => routeLightningUrl('lightning:lnbc1early'))
  expect(mockNavigate).not.toHaveBeenCalled()

  lock(false)
  expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1early' }]])
})

// The relock as App.tsx wires it: the real decision over the native side's stamp, the navigator under
// UnderLock, and a PIN whose press is the unlock.
describe('a link that brings the app back', () => {
  const { device } = jest.requireMock('../specs/NativeVoltzPrivacy') as {
    device: typeof import('../specs/__mocks__/NativeVoltzPrivacy').device
  }
  let listeners: ((state: string) => void)[] = []

  function Wallet(): React.JSX.Element {
    const [relocked, setRelocked] = React.useState(false)
    useRelock(true, relocked, async () => setRelocked(true))
    return (
      <>
        <UnderLock locked={relocked}>
          <RootNavigator />
        </UnderLock>
        {relocked && <Text onPress={() => setRelocked(false)}>PIN</Text>}
      </>
    )
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await ReactTestRenderer.act(async () => {
        await Promise.resolve()
      })
    }
  }

  async function appState(state: string): Promise<void> {
    await ReactTestRenderer.act(async () => {
      Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: state })
      listeners.slice().forEach(listener => listener(state))
    })
    await settle()
  }

  // Leaves, stays away `ms`, and comes back with a link, which the platform hands over before the
  // return is 'active'.
  async function returnWithLink(ms: number, url: string): Promise<void> {
    await appState('inactive')
    device.leave()
    await appState('background')
    device.advance(ms)
    ReactTestRenderer.act(() => routeLightningUrl(url))
    expect(mockNavigate).not.toHaveBeenCalled()
    await appState('active')
  }

  const pin = () =>
    tree!.root.findAll(n => typeof n.props.onPress === 'function' && n.findAllByType(Text).some(t => t.props.children === 'PIN'))

  beforeEach(async () => {
    listeners = []
    Object.defineProperty(AppState, 'currentState', { configurable: true, writable: true, value: 'active' })
    jest.mocked(AppState.addEventListener).mockImplementation(((_: string, cb: (state: string) => void) => {
      listeners.push(cb)
      return { remove: () => listeners.splice(listeners.indexOf(cb), 1) }
    }) as never)
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<Wallet />)
    })
    await settle()
  })

  it('opens nothing on a return that locks, and opens it once after the unlock', async () => {
    await returnWithLink(RELOCK_AFTER_MS, 'lightning:lnbc1back')
    expect(pin()).not.toHaveLength(0)
    expect(mockNavigate).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => pin()[0].props.onPress())
    await settle()
    expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1back' }]])
  })

  it('opens it at once on a return under the limit', async () => {
    await returnWithLink(RELOCK_AFTER_MS - 1, 'lightning:lnbc1short')
    expect(pin()).toHaveLength(0)
    expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1short' }]])
  })

  // A pause for the app's own activity is timed against its own limit, and holds the link the same way.
  async function pickThenLink(ms: number, url: string): Promise<void> {
    let finish!: () => void
    const picking = asOwnActivity(() => new Promise<void>(resolve => (finish = resolve)))
    device.leave()
    await appState('background')
    device.advance(ms)
    ReactTestRenderer.act(() => routeLightningUrl(url))
    await ReactTestRenderer.act(async () => {
      finish()
      await picking
    })
    expect(mockNavigate).not.toHaveBeenCalled()
    await appState('active')
  }

  it("opens it at once after the app's own activity under its limit", async () => {
    await pickThenLink(RELOCK_AFTER_OWN_MS - 1, 'lightning:lnbc1pick')
    expect(pin()).toHaveLength(0)
    expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1pick' }]])
  })

  it("holds it through the lock after the app's own activity at its limit", async () => {
    await pickThenLink(RELOCK_AFTER_OWN_MS, 'lightning:lnbc1longpick')
    expect(pin()).not.toHaveLength(0)
    expect(mockNavigate).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => pin()[0].props.onPress())
    await settle()
    expect(mockNavigate).toHaveBeenCalledTimes(1)
  })

  it('a short trip while the PIN is up still waits for the unlock', async () => {
    await returnWithLink(RELOCK_AFTER_MS, 'lightning:lnbc1first')
    await ReactTestRenderer.act(async () => pin()[0].props.onPress())
    await settle()
    mockNavigate.mockClear()
    await returnWithLink(RELOCK_AFTER_MS, 'lightning:lnbc1second')
    expect(mockNavigate).not.toHaveBeenCalled()

    await returnWithLink(RELOCK_AFTER_MS - 1, 'lightning:lnbc1third')
    expect(pin()).not.toHaveLength(0)
    expect(mockNavigate).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => pin()[0].props.onPress())
    await settle()
    expect(mockNavigate.mock.calls).toEqual([['Send', { destination: 'lightning:lnbc1third' }]])
  })
})

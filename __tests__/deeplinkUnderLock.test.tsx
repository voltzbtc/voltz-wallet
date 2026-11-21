import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import '../src/i18n'
import { RootNavigator } from '../src/navigation/RootNavigator'
import { UnderLock } from '../src/components/UnderLock'
import { routeLightningUrl, setDeeplinkHandler } from '../src/wallet/deeplink'

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
  // Drains anything a test left stashed, so it cannot reach the next one.
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

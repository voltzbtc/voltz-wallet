import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
// Rendering in isolation bypasses App.tsx, so i18n must be initialized or t() returns raw keys.
import i18n from '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { GradientButton } from '../src/components/GradientButton'
import { Touch } from '../src/components/Touch'
import { connectActiveSpark, sparkGetWalletInfo, sparkGetFiatRates } from '../src/wallet/spark'

// spark.ts is replaced whole, so a connect the previous wallet started can resolve after a switch
// instead of being rejected as superseded, which is what the real module does. That leaves Home's own
// guards as the only thing between a late connect and a press made for the next wallet.

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => 'wallet-a',
  onSparkSynced: () => () => undefined,
  onSparkRecoverableFunds: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  connectActiveSpark: jest.fn(),
  onSparkConnected: () => () => undefined,
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

// The switch announcement Home listens to, fired by the test as the wallet module would.
const mockSwitchListeners: Array<(id: string) => void> = []
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: (id: string) => void) => {
    mockSwitchListeners.push(cb)
    return () => mockSwitchListeners.splice(mockSwitchListeners.indexOf(cb), 1)
  },
}))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => null) }))
jest.mock('../src/wallet/identitySigner', () => ({
  identitySigner: jest.fn(async () => ({ pubkey: '02aa', sign: async () => 'sig' })),
}))
jest.mock('../src/wallet/recover', () => ({
  recoverPurchases: jest.fn(async () => null),
  putBackCard: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/deletion', () => ({ readDeletionOnFocus: jest.fn(async () => undefined) }))
jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  loadDollarInviteSeen: jest.fn(async () => 0),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

const mockNavigation = { navigate: jest.fn(), isFocused: jest.fn(() => true) }
let mockFocused = true
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]),
  }
})

// Each connect answers only when the test says, in any order.
let pending: Array<() => void> = []
function holdConnects(): void {
  jest.mocked(connectActiveSpark).mockImplementation(
    () => new Promise<void>(resolve => pending.push(() => resolve())),
  )
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  return tree
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target =
    tree.root.findAllByType(GradientButton).find(b => b.props.label === label) ??
    tree.root.findAllByType(Touch).find(b => b.props.label === label)
  if (!target) {
    throw new Error(`no ${label} on screen`)
  }
  await ReactTestRenderer.act(async () => {
    await target.props.onPress()
  })
}

async function switchWallet(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    mockSwitchListeners.forEach(cb => cb('wallet-b'))
  })
}

async function refocus(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocused = false
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  mockFocused = true
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  await settle()
}

async function land(index: number): Promise<void> {
  await ReactTestRenderer.act(async () => pending[index]())
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  pending = []
  mockFocused = true
  mockNavigation.isFocused.mockReturnValue(true)
  holdConnects()
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 0, tokens: [] })
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
})

describe('a press held while the connect is out, across a wallet switch', () => {
  test('a press made before the switch never opens on the next wallet once its connect lands', async () => {
    const tree = await render()
    await press(tree, 'Send')

    await switchWallet()
    await refocus(tree)
    expect(pending).toHaveLength(2)
    await land(1)

    expect(mockNavigation.navigate).not.toHaveBeenCalled()
  })

  test("the previous wallet's connect resolving late never releases a press made after the switch", async () => {
    const tree = await render()

    await switchWallet()
    await press(tree, 'Receive')
    await land(0)

    expect(mockNavigation.navigate).not.toHaveBeenCalled()

    // The next wallet's own connect is what releases it.
    await refocus(tree)
    await land(1)
    expect(mockNavigation.navigate.mock.calls).toEqual([['Receive']])
  })
})

describe('a press held before the connect shows that it waits', () => {
  const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root.findAllByType(GradientButton).find(b => b.props.label === label)
  const scan = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(Touch).find(b => b.props.label === 'Scan')

  test('the held button is busy and the others are not', async () => {
    const tree = await render()
    expect(button(tree, 'Send')?.props.loading).toBe(false)

    await press(tree, 'Send')

    expect(button(tree, 'Send')?.props.loading).toBe(true)
    expect(button(tree, 'Receive')?.props.loading).toBe(false)
    expect(scan(tree)?.props.disabled).toBe(false)
    expect(scan(tree)?.props.state).toEqual({ busy: false })
  })

  test('a held Scan is busy and drawn disabled', async () => {
    const tree = await render()

    await press(tree, 'Scan')

    expect(scan(tree)?.props.disabled).toBe(true)
    expect(scan(tree)?.props.state).toEqual({ busy: true })
    expect(button(tree, 'Send')?.props.loading).toBe(false)
  })

  test('a second press while one is held changes nothing, and the landing opens the first only', async () => {
    const tree = await render()
    await press(tree, 'Send')
    await press(tree, 'Send')
    await press(tree, 'Receive')
    await press(tree, 'Scan')

    expect(button(tree, 'Send')?.props.loading).toBe(true)
    expect(button(tree, 'Receive')?.props.loading).toBe(false)
    expect(scan(tree)?.props.disabled).toBe(false)

    await land(0)

    expect(mockNavigation.navigate.mock.calls).toEqual([['Send']])
    expect(button(tree, 'Send')?.props.loading).toBe(false)
  })

  test('a connect that fails clears the mark and opens nothing', async () => {
    let fail: (() => void) | undefined
    jest
      .mocked(connectActiveSpark)
      .mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = () => reject(new Error('offline')))))
    const tree = await render()
    await press(tree, 'Send')
    expect(button(tree, 'Send')?.props.loading).toBe(true)

    await ReactTestRenderer.act(async () => fail?.())
    await settle()
    expect(mockNavigation.navigate).not.toHaveBeenCalled()

    // Try again brings the buttons back with no mark, and its connect opens nothing.
    // Not awaited, since the load it starts waits on a connect the test answers below.
    const retry = button(tree, i18n.t('home.retry'))
    await ReactTestRenderer.act(async () => {
      retry?.props.onPress()
    })
    await settle()
    expect(button(tree, 'Send')?.props.loading).toBe(false)
    await land(0)
    expect(mockNavigation.navigate).not.toHaveBeenCalled()
  })

  test('a switch while held clears the mark', async () => {
    const tree = await render()
    await press(tree, 'Receive')
    expect(button(tree, 'Receive')?.props.loading).toBe(true)

    await switchWallet()

    expect(button(tree, 'Receive')?.props.loading).toBe(false)
  })

  test('a landing after the screen lost focus clears the mark and opens nothing', async () => {
    const tree = await render()
    await press(tree, 'Send')
    mockNavigation.isFocused.mockReturnValue(false)

    await land(0)

    expect(mockNavigation.navigate).not.toHaveBeenCalled()
    expect(button(tree, 'Send')?.props.loading).toBe(false)
  })
})

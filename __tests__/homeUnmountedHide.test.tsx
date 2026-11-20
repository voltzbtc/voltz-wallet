import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { AssetList } from '../src/components/AssetList'
import { connectActiveSpark, sparkGetFiatRates, sparkGetWalletInfo } from '../src/wallet/spark'
import { removeToken } from '../src/wallet/tokenPrefs'
import { USDB } from '../src/wallet/tokens'

// React 19 drops a state write to an unmounted tree without a warning, so the only trace a write
// leaves after the Home unmounts is the call itself. Every state setter is counted while `open`.
const mockWrites = { open: false, count: 0 }
jest.mock('react', () => {
  const actual = jest.requireActual('react')
  // One wrapper per setter, so a setter keeps its identity across renders as React's own does.
  const counted = new WeakMap<object, unknown>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const [value, set] = actual.useState(initial)
      if (!counted.has(set)) {
        counted.set(set, (next: unknown) => {
          if (mockWrites.open) {
            mockWrites.count += 1
          }
          set(next)
        })
      }
      return [value, counted.get(set)]
    },
  }
})

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  sparkSetStableBalance: jest.fn(async () => undefined),
  sparkConversionLimits: jest.fn(async () => ({})),
  sparkPrepareConvertBySpend: jest.fn(),
  sparkDiscardConvertQuote: jest.fn(),
  onSparkSynced: () => () => undefined,
  onSparkRecoverableFunds: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  connectActiveSpark: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})
jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  loadDollarInviteSeen: jest.fn(async () => 0),
  saveDollarInviteSeen: jest.fn(async () => undefined),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/tokenPrefs', () => {
  const actual = jest.requireActual('../src/wallet/tokenPrefs')
  return { ...actual, removeToken: jest.fn(actual.removeToken) }
})
const mockNavigation = { navigate: jest.fn() }
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(() => callback(), [callback]),
  }
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  mockWrites.open = false
  mockWrites.count = 0
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 21_000,
    tokens: [],
  })
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
})

// The refusal is about a Home that is gone, and a write to it would land on nothing. The unmount
// moves the same epoch a wallet switch moves, so the one check turns both away.
test('a hide refused after the Home unmounts writes nothing and logs nothing', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  let refuse!: () => void
  jest.mocked(removeToken).mockImplementationOnce(
    () => new Promise<void>((_, reject) => (refuse = () => reject(new Error('lists refused')))),
  )
  const list = tree.root.findByType(AssetList)
  const rows = list.props.assets as { assetId: string }[]
  expect(rows.map(row => row.assetId)).toContain(USDB.identifier)
  await ReactTestRenderer.act(async () => list.props.onRemove(USDB.identifier))
  await settle()
  ReactTestRenderer.act(() => tree.unmount())
  await settle()

  const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    mockWrites.open = true
    await ReactTestRenderer.act(async () => refuse())
    await settle()
    mockWrites.open = false

    expect(mockWrites.count).toBe(0)
    expect(errors).not.toHaveBeenCalled()
  } finally {
    errors.mockRestore()
  }
})

// The counter's control: the same refusal on a Home still mounted writes, so a zero above is the
// guard and not a counter that cannot count.
test('the same refusal on a mounted Home writes the line', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  let refuse!: () => void
  jest.mocked(removeToken).mockImplementationOnce(
    () => new Promise<void>((_, reject) => (refuse = () => reject(new Error('lists refused')))),
  )
  const list = tree.root.findByType(AssetList)
  await ReactTestRenderer.act(async () => list.props.onRemove(USDB.identifier))
  await settle()

  mockWrites.open = true
  await ReactTestRenderer.act(async () => refuse())
  await settle()
  mockWrites.open = false

  expect(mockWrites.count).toBeGreaterThan(0)
  const said = tree.root.findAllByType(Text).map(node => node.props.children)
  expect(said).toContain(i18n.t('home.hideFailed'))
  ReactTestRenderer.act(() => tree.unmount())
})

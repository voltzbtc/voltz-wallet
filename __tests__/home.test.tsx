import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, Modal, ScrollView, StyleSheet, Text } from 'react-native'
// Rendering in isolation bypasses App.tsx, so i18n must be initialized or t() returns raw keys.
import i18n from '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { FontScaleProvider } from '../src/components/Text'
import { AssetList } from '../src/components/AssetList'
import { Skeleton } from '../src/components/Skeleton'
import { GlassCard } from '../src/components/GlassCard'
import { Touch } from '../src/components/Touch'
import { TabIcon } from '../src/components/TabIcon'
import { SectionLabel } from '../src/components/SectionLabel'
import { AddRow } from '../src/components/AddRow'
import { UnclaimedDepositsCard } from '../src/components/UnclaimedDepositsCard'
import {
  connectActiveSpark,
  sparkConnectedWalletId,
  sparkSubscribeToPayments,
  sparkGetWalletInfo,
  sparkGetFiatRates,
  sparkListFiatCurrencies,
  sparkPrepareConvertBySpend,
  sparkSetStableBalance,
  type SparkToken,
  sparkListUnclaimedDeposits,
} from '../src/wallet/spark'
import { loadDisplayCurrency, loadDollarInviteSeen, loadHeroUnit, saveDollarInviteSeen } from '../src/wallet/settings'
import RNFS from 'react-native-fs'
import { isUnconfirmed, markUnconfirmed } from '../src/wallet/backupMark'
import { BackupCard } from '../src/components/BackupCard'
import { getCurrencies } from 'react-native-localize'
import { setLocalCurrency } from '../src/wallet/fiat'
import { DEPIX, USDB } from '../src/wallet/tokens'
import { loadHomeTokens, removeToken } from '../src/wallet/tokenPrefs'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'
import { formatSats } from '../src/wallet/amount'
import { colors, font, radius, space, touch } from '../src/theme'

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
  // The payment listener attaches on connect, so fire the callback for the subscription to run.
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  // The Home renders UnclaimedDepositsCard, which self-loads deposits.
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

// The mode comes from the shared provider, the same one the chrome reads, so the screen and the
// wordmark can never disagree about it.
let mockDollarMode = false
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => mockDollarMode,
    useAccent: () =>
      mockDollarMode
        ? { accent: theme.colors.dollar, gradient: theme.gradients.dollar }
        : { accent: theme.colors.primary, gradient: theme.gradients.primary },
  }
})

jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  loadDollarInviteSeen: jest.fn(async () => 0),
  saveDollarInviteSeen: jest.fn(async () => undefined),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))

// The real modules, with a switch announced from the test and a hide's answer held by it.
const mockSwitchListeners = new Set<(id: string) => void>()
// Trees from earlier tests stay mounted, so each test starts with no listener left from them.
beforeEach(() => mockSwitchListeners.clear())
jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  onActiveWalletChanged: (cb: (id: string) => void) => {
    mockSwitchListeners.add(cb)
    return () => {
      mockSwitchListeners.delete(cb)
    }
  },
}))
jest.mock('../src/wallet/tokenPrefs', () => {
  const actual = jest.requireActual('../src/wallet/tokenPrefs')
  return { ...actual, removeToken: jest.fn(actual.removeToken), loadHomeTokens: jest.fn(actual.loadHomeTokens) }
})

function mockSparkWallet(balanceSat: number, tokens: SparkToken[] = []): void {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat, tokens })
}

// One navigation object for the whole file, like the real useNavigation, so callbacks stay stable.
const mockNavigate = jest.fn()
const mockNavigation = { navigate: mockNavigate }

// Flipping this and re-rendering runs the effect's cleanup, which is what a blur does, and running
// the callback again is what regaining focus does.
let mockFocused = true
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]),
  }
})

// The leak guard at the end of the file checks that none of these words reach the screen.
const MNEMONIC =
  'abandon ability able about above absent absorb abstract absurd abuse access accident'

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function pressRetry(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === 'Try again'))
  if (!button) {
    throw new Error('retry button not found')
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined)
  mockSparkWallet(0)
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
  mockDollarMode = false
  mockFocused = true
})

describe('the wallet balance', () => {
  test('connects the Spark engine and shows the BTC balance', async () => {
    mockSparkWallet(4200)

    const tree = await render()

    expect(connectActiveSpark).toHaveBeenCalled()
    // The hero nests the "sats" unit after a non-breaking space, so strip whitespace before matching.
    expect(texts(tree).join('').replace(/\s/g, '')).toContain(`${formatSats(4200)}sats`.replace(/\s/g, ''))
  })

  test('lists Bitcoin and the zero-balance USDB catalog row when no tokens are held', async () => {
    mockSparkWallet(4200)

    // The rows render inside a FlatList the test renderer does not materialize, so read the props.
    const rendered = await render()
    const rows = rendered.root.findByType(AssetList).props.assets as {
      name: string
      amount: string
      removable: boolean
    }[]
    expect(rows.map(row => row.name)).toEqual(['Bitcoin', 'Bitcoin USD'])
    expect(rows[1]).toMatchObject({ name: 'Bitcoin USD', amount: '0', removable: true })
  })

  // Every asset list shares this order, so a token sits in the same place on each screen.
  test('lists Bitcoin, then the known tokens, then any other token, held or not', async () => {
    mockSparkWallet(4200, [
      {
        identifier: 'tkn1',
        ticker: 'USDs',
        name: 'Spark USD',
        decimals: 6,
        balanceBaseUnits: 1_500_000,
      },
    ])

    const rendered = await render()
    const rows = rendered.root.findByType(AssetList).props.assets as {
      name: string
      amount: string
    }[]
    expect(rows.map(row => row.name)).toEqual(['Bitcoin', 'Bitcoin USD', 'Spark USD'])
    expect(rows[2].amount).toBe('1.5') // 1_500_000 base units at 6 decimals
  })

  test('tapping an asset row opens that asset screen, named', async () => {
    // AssetList is stubbed in jest, so what is asserted is the contract the Home hands it.
    mockSparkWallet(4200, [
      {
        identifier: 'tkn1',
        ticker: 'USDs',
        name: 'Spark USD',
        decimals: 6,
        balanceBaseUnits: 1_500_000,
      },
    ])

    const rendered = await render()
    const list = rendered.root.findByType(AssetList).props
    const token = list.assets.find((row: { assetId: string }) => row.assetId === 'tkn1')
    ReactTestRenderer.act(() => list.onOpen(token))

    expect(mockNavigate).toHaveBeenCalledWith('AssetDetail', {
      assetId: 'tkn1',
      name: 'Spark USD',
    })
  })

  test('shows Convert and the Add-asset control', async () => {
    const shown = texts(await render())
    expect(shown).toContain('Convert')
    expect(shown).toContain('Add asset')
  })

  test('the Add-asset control opens the Add-asset screen', async () => {
    const rendered = await render()
    const button = rendered.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === 'Add asset'))
    if (!button) {
      throw new Error('add-asset control not found')
    }
    ReactTestRenderer.act(() => button.props.onPress())
    expect(mockNavigate).toHaveBeenCalledWith('AddAsset')
  })

  test('shows zero balance without confusing it with a loading state', async () => {
    mockSparkWallet(0)

    const tree = await render()

    // Joined with a space, since the value and its unit are two elements with a layout gap rather
    // than one string carrying the space inside it.
    expect(texts(tree).join(' ')).toContain('0 sats')
    expect(texts(tree)).not.toContain('Loading...')
  })

  test('fetches the display currency and the token peg rate (USD), to value a dollar balance', async () => {
    // A USDB holding is pegged to USD, so the peg is fetched alongside the display currency.
    mockSparkWallet(100_000)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000 })

    await render()

    expect(sparkGetFiatRates).toHaveBeenCalledWith(['BRL', 'USD'])
  })

  test('the total values a held USDB balance, not just BTC (dollar-wallet balance is not zero)', async () => {
    // A total that ignores tokens reads zero while the dollar wallet is full.
    mockSparkWallet(0, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    jest.mocked(loadHeroUnit).mockResolvedValueOnce('fiat')

    const tree = await render()

    expect(texts(tree)).toContain('R$55.00')
  })

  test('with the dollar wallet on, the hero leads with the dollar value and says what the mode does', async () => {
    mockSparkWallet(0, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true

    const tree = await render()
    const shown = texts(tree)

    // Dollars lead, because that is the figure the dollar wallet keeps still while the rate moves.
    expect(shown).toContain('$10.00')
    // The line under it names the mode by what it does, not by a bitcoin equivalent nobody holds.
    expect(shown).toContain('Bitcoin you receive turns into dollars')
    expect(shown.some(s => s.startsWith('≈'))).toBe(false)
  })

  // An Australian reads a bare $ as the Australian dollar, so the dollar hero says whose dollar it is.
  test('on an Australian device the dollar hero writes US$, never a bare $', async () => {
    mockSparkWallet(0, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true
    setLocalCurrency(['AUD'])
    try {
      const tree = await render()

      expect(texts(tree)).toContain('US$10.00')
      expect(texts(tree)).not.toContain('$10.00')
      const hero = tree.root
        .findAllByType(Touch)
        .find(node => String(node.props.label ?? '').startsWith('Total Balance'))!
      expect(hero.props.label).toBe('Total Balance, US$10.00')
    } finally {
      // The same read src/i18n made when it loaded, so this puts back what the boot set.
      setLocalCurrency(getCurrencies())
    }
  })

  test('tapping the dollar hero toggles the value between the display currency and USD', async () => {
    mockSparkWallet(0, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true

    const tree = await render()
    expect(texts(tree)).toContain('$10.00')

    const hero = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === '$10.00'))
    await ReactTestRenderer.act(async () => {
      hero?.props.onPress()
    })

    // The tap reaches the currency chosen in settings.
    expect(texts(tree)).toContain('R$55.00')
  })

  test('with no Convert link the label stays centred in its row, so the gap to the card holds', async () => {
    mockSparkWallet(0, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true

    const tree = await render()
    const row = tree.root
      .findAll(node => typeof node.type === 'string')
      .map(node => StyleSheet.flatten(node.props.style) ?? {})
      .find(style => style.flexWrap === 'wrap' && style.minHeight === touch.min)

    expect(texts(tree)).not.toContain(i18n.t('home.convert'))
    expect(row?.alignContent).toBe('center')
  })

  test('dollar mode drops the bitcoin row and Convert, and flags the mode', async () => {
    mockSparkWallet(0, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true

    const tree = await render()

    const rows = tree.root.findByType(AssetList).props.assets as { assetId: string }[]
    expect(rows.some(r => r.assetId === BITCOIN_ASSET_ID)).toBe(false)
    expect(rows.some(r => r.assetId === USDB.identifier)).toBe(true)
    // With only USDB held there is nothing to convert, so Convert is hidden.
    const shown = texts(tree)
    expect(shown).not.toContain('Convert')
    expect(shown).toContain('Bitcoin you receive turns into dollars')
  })

  test('dollar mode still shows the bitcoin row when a residual sat balance remains (never hides funds)', async () => {
    // Sats from a payment that has not auto-converted are real funds the row must not hide.
    mockSparkWallet(1000, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true

    const tree = await render()

    const rows = tree.root.findByType(AssetList).props.assets as { assetId: string }[]
    expect(rows.some(r => r.assetId === BITCOIN_ASSET_ID)).toBe(true)
    expect(rows.some(r => r.assetId === USDB.identifier)).toBe(true)
  })

  test('the fiat line is not a control: tapping it changes nothing', async () => {
    mockSparkWallet(100_000)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000 })

    const tree = await render()
    const shown = texts(tree)

    expect(shown).toContain('R$550.00')
    const pressables = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .filter(node => node.findAllByType(Text).some(text => text.props.children === 'R$550.00'))
    expect(pressables).toHaveLength(0)
  })

  test('shows the balance in a chosen international currency (EUR), not just BRL/USD', async () => {
    mockSparkWallet(100_000) // 0.001 BTC
    jest.mocked(loadDisplayCurrency).mockResolvedValue('EUR')
    jest
      .mocked(sparkListFiatCurrencies)
      .mockResolvedValue([{ id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }])
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ EUR: 100_000 })

    const tree = await render()

    expect(sparkGetFiatRates).toHaveBeenCalledWith(expect.arrayContaining(['EUR']))
    expect(texts(tree).join('')).toContain('€100.00')
  })
})

// The hero's touch label replaces what it draws, so it has to carry the figure.
describe('the balance as a screen reader hears it', () => {
  const hero = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(Touch).find(node => String(node.props.label ?? '').startsWith('Total Balance'))!

  test('names the figure the hero draws, in the unit drawn, and says hidden when it is hidden', async () => {
    mockSparkWallet(3_062)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })

    const tree = await render()
    expect(hero(tree).props.label).toBe(`Total Balance, ${formatSats(3_062)} sats`)

    await ReactTestRenderer.act(async () => hero(tree).props.onPress())
    expect(hero(tree).props.label).toBe('Total Balance, 0.00003062 BTC')

    const eye = tree.root.findAllByType(Touch).find(node => node.props.label === 'Hide')!
    await ReactTestRenderer.act(async () => eye.props.onPress())
    expect(hero(tree).props.label).toBe('Total Balance, hidden')
  })

  test('names the dollar figure when the dollar hero leads', async () => {
    mockSparkWallet(0, [
      { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true

    const tree = await render()

    expect(texts(tree)).toContain('$10.00')
    expect(hero(tree).props.label).toBe('Total Balance, $10.00')
  })
})

// The plus and its label share the wallet's accent even when the dollar figure cannot be drawn.
test('the Add asset plus keeps the dollar accent of its label when the rates did not load', async () => {
  mockSparkWallet(0, [
    { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
  ])
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
  mockDollarMode = true

  const tree = await render()

  const plus = tree.root.findAllByType(TabIcon).find(icon => icon.props.name === 'plus')!
  expect(texts(tree)).not.toContain('$10.00')
  expect(plus.props.color).toBe(colors.dollar)
})

// The blocks above the assets fill most of a 667pt screen, so the list only stays reachable when the
// screen scrolls. Whether it fits on a given phone is a device check.
test('the asset rows and Add asset sit inside the scrolling screen', async () => {
  mockSparkWallet(3_062, [
    { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
    { identifier: DEPIX.identifier, ticker: 'DEPIX', name: 'DePix', decimals: 8, balanceBaseUnits: 500_000_000 },
  ])

  const tree = await render()

  const scroll = tree.root.findAllByType(ScrollView)
  expect(scroll).toHaveLength(1)
  expect(scroll[0].findAllByType(AssetList)).toHaveLength(1)
  expect(scroll[0].findAllByType(Text).some(text => text.props.children === 'Add asset')).toBe(true)
})

// design-system.md gives Home's asset panel radius.xxl, and the skeleton takes the panel's shape.
test('the asset panel and its skeleton take the large panel radius', async () => {
  jest.mocked(sparkGetWalletInfo).mockReturnValueOnce(new Promise(() => undefined))
  const waiting = await render()
  const panelRadius = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(GlassCard).map(card => StyleSheet.flatten(card.props.style).borderRadius)
  expect(panelRadius(waiting)).toEqual([radius.xxl])

  mockSparkWallet(3_062)
  const ready = await render()
  expect(panelRadius(ready)).toEqual([radius.xxl])
})

describe('connection errors', () => {
  test('shows the connect error when there is no stored wallet', async () => {
    // The no-wallet check lives in connectActiveSpark, which rejects when the active seed is missing.
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('no wallet stored'))

    const tree = await render()

    expect(texts(tree)).toContain('Could not connect to the wallet.')
  })

  // The cause is stated as a translated code, never as the SDK's raw text.
  test('states the cause in the app language when the connection fails, never the raw message', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('spark unreachable'))

    const tree = await render()

    const shown = texts(tree)
    expect(shown).toContain('Could not connect to the wallet.')
    expect(shown).toContain(i18n.t('errors.offline'))
    expect(shown.join(' ')).not.toContain('spark unreachable')
  })

  test('a cause it cannot name adds no line under the title', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('BreezSdkError: Generic(rpc status 13)'))

    const tree = await render()

    const shown = texts(tree).join(' ')
    expect(shown).toContain('Could not connect to the wallet.')
    expect(shown).not.toContain('rpc status')
    expect(shown).not.toContain('errors.unknown')
  })

  // classifyWalletError also matches payment words a connect error can carry, and an invoice line
  // under the connection title would name a cause that never happened.
  test.each([
    ['invalid response from the operator', 'errors.invalidInput'],
    ['session expired', 'errors.expiredInvoice'],
  ])('a connect error reading "%s" adds no payment line under the title', async (message, key) => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error(message))

    const shown = texts(await render())

    expect(shown).toContain('Could not connect to the wallet.')
    expect(shown).not.toContain(i18n.t(key))
    expect(shown.join(' ')).not.toContain(message)
  })

  test('a connect refused as deleted says no new address is made, under the title', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('deleted'))

    const shown = texts(await render())

    expect(shown).toContain('Could not connect to the wallet.')
    expect(shown).toContain(i18n.t('errors.deleted'))
  })

  test('a connect a newer request replaced shows no error, and the skeleton waits', async () => {
    const superseded = new Error('spark connect superseded')
    superseded.name = 'SparkConnectSuperseded'
    jest.mocked(connectActiveSpark).mockRejectedValue(superseded)

    const tree = await render()

    expect(texts(tree)).not.toContain('Could not connect to the wallet.')
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
  })

  test('does not show a balance when the connection fails', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('spark unreachable'))

    const tree = await render()

    expect(texts(tree).some(text => text.includes('sats'))).toBe(false)
  })

  test('the retry button redoes the connection and shows the balance', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('spark unreachable'))
    mockSparkWallet(777)

    const tree = await render()
    expect(texts(tree)).toContain('Could not connect to the wallet.')

    await pressRetry(tree)

    expect(connectActiveSpark).toHaveBeenCalledTimes(2)
    expect(texts(tree).join(' ')).toContain('777 sats')
    expect(texts(tree)).not.toContain('Could not connect to the wallet.')
  })

  test('does not leak the mnemonic on screen', async () => {
    const tree = await render()

    const shown = texts(tree).join(' ')
    for (const word of MNEMONIC.split(' ')) {
      expect(shown).not.toContain(word)
    }
  })
})

// Sitting on Home untouched is the ordinary case, so an arrival has to repaint the screen on its own.
test('an arriving payment repaints the balance without any interaction', async () => {
  mockSparkWallet(10_000)
  const tree = await render()
  expect(texts(tree).join(' ').replace(/\s/g, '')).toContain(formatSats(10_000).replace(/\s/g, ''))

  mockSparkWallet(25_000)
  const notify = jest.mocked(sparkSubscribeToPayments).mock.calls.at(-1)?.[0] as () => void
  await ReactTestRenderer.act(async () => {
    notify()
    // Home debounces the refetch, so the wait has to outlast the debounce for the reload to happen.
    await new Promise(resolve => setTimeout(resolve, 800))
  })

  expect(texts(tree).join(' ').replace(/\s/g, '')).toContain(formatSats(25_000).replace(/\s/g, ''))
})

// Home stays mounted under the screen pushed on top. Reloading it there is what lets it come back
// showing the balance a payment settled, since the load on focus takes seconds to answer.
describe('the payment refresh while Home is off screen', () => {
  const loads = () => jest.mocked(sparkGetWalletInfo).mock.calls.length
  const notify = () => jest.mocked(sparkSubscribeToPayments).mock.calls.at(-1)?.[0] as () => void
  // Outlasts the 600 ms debounce, so a reload that is going to happen has happened.
  const outlastDebounce = () => new Promise(resolve => setTimeout(resolve, 800))

  async function setFocus(tree: ReactTestRenderer.ReactTestRenderer, focused: boolean) {
    mockFocused = focused
    await ReactTestRenderer.act(async () => {
      tree.update(<HomeScreen />)
    })
  }

  test('a payment settling behind another screen reloads Home, so it comes back up to date', async () => {
    const tree = await render()
    await setFocus(tree, false)
    const before = loads()

    await ReactTestRenderer.act(async () => {
      notify()()
      await outlastDebounce()
    })

    expect(loads()).toBe(before + 1)
  })

  test('back on screen, a payment reloads Home again', async () => {
    const tree = await render()
    await setFocus(tree, false)
    await setFocus(tree, true)
    const before = loads()

    await ReactTestRenderer.act(async () => {
      notify()()
      await outlastDebounce()
    })

    expect(loads()).toBe(before + 1)
  })

  test('regaining focus loads, which catches up on what settled while away', async () => {
    const tree = await render()
    await setFocus(tree, false)
    const before = loads()

    await setFocus(tree, true)

    expect(loads()).toBe(before + 1)
  })
})

describe('the balance block, which is the first thing anyone sees', () => {
  // The accent that says which wallet you are in, the unit beside the largest number in the app,
  // and the control that hides the balance from whoever is standing next to you are held here, each
  // the most visible of its kind.
  const balanceStyle = (tree: ReactTestRenderer.ReactTestRenderer) => {
    const node = tree.root
      .findAllByType(Text)
      .map(n => ({
        node: n,
        size: Object.assign(
          {},
          ...[n.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
        ).fontSize as number | undefined,
      }))
      .filter(x => typeof x.size === 'number')
      .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]!.node
    return Object.assign(
      {},
      ...[node.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
    )
  }

  const eye = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
      .find(n => n.findAllByType(Text).length === 0)!

  // Pending funds are part of the balance, so the eye hides them with it.
  test('hiding the balance hides the pending deposit too', async () => {
    mockSparkWallet(21_000)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
      { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'arriving', refundable: false },
    ])
    const tree = await render()
    expect(texts(tree).some(text => text.includes(formatSats(50_000)))).toBe(true)

    await ReactTestRenderer.act(async () => eye(tree).props.onPress())

    expect(texts(tree).some(text => text.includes(formatSats(50_000)))).toBe(false)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
  })

  // Nothing pending is spendable yet, so it never joins the figure at the top.
  test('money on its way stays out of the balance', async () => {
    mockSparkWallet(21_000)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
      { txid: 'a', vout: 0, amountSat: 50_000, claimable: false, stage: 'arriving', refundable: false },
    ])
    const tree = await render()

    expect(texts(tree).join(' ')).toContain(`≈ ${formatSats(50_000)} sats arriving`)
    expect(texts(tree).some(text => text.includes(formatSats(71_000)))).toBe(false)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
  })

  test('carries the wallet accent, which is the only thing saying which wallet is open', async () => {
    mockSparkWallet(21_000)
    expect(balanceStyle(await render()).color).toBe(colors.primary)
  })

  test('says BTC when showing BTC, and sats when showing sats', async () => {
    // The unit beside the largest number in the app. Pinned to sats, 0.00021 would read as
    // "0.00021 sats", which is the mistake Amount exists to stop.
    mockSparkWallet(21_000)
    const tree = await render()
    expect(texts(tree)).toContain('sats')

    const hero = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => String(x.props.children).includes('21')))!
    await ReactTestRenderer.act(async () => hero.props.onPress())
    expect(texts(tree)).toContain('BTC')
    expect(texts(tree)).not.toContain('sats')
  })

  test('hides the figure when asked, and the currency line with it', async () => {
    // A privacy control. Disconnected, it leaves the balance on screen for anyone beside you.
    mockSparkWallet(21_000)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    const tree = await render()
    expect(texts(tree).join(' ')).toContain('21')

    await ReactTestRenderer.act(async () => eye(tree).props.onPress())
    expect(texts(tree).join(' ')).not.toContain('21')
    expect(texts(tree)).toContain('••••••')
    // Four dots rather than six, because the currency line masks separately, and it is the line a
    // person standing beside you reads without converting anything. An assertion looking only for
    // the six-dot figure passes with the currency still on screen, which is the feature not doing
    // its job.
    expect(texts(tree)).toContain('••••')
  })

  test('keeps the currency line on fixed-width figures, since it changes on its own', async () => {
    // The reason `tabular` exists, applied to the one number on this screen that updates without
    // anybody touching it. Without it the line shifts sideways as the balance moves.
    mockSparkWallet(21_000)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    const tree = await render()
    const fiat = tree.root.findAllByType(Text).find(n => String(n.props.children).includes('R$'))
    const style = Object.assign(
      {},
      ...[fiat?.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
    )
    expect(style.fontVariant).toEqual(['tabular-nums'])
  })
})

describe('the dollar mode line', () => {
  const dollarWallet = (sats: number) => {
    mockSparkWallet(sats, [
      {
        identifier: USDB.identifier,
        ticker: 'USDB',
        name: 'Bitcoin USD',
        decimals: 6,
        balanceBaseUnits: 10_000_000,
      },
    ])
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true
  }
  const eye = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
      .find(n => n.findAllByType(Text).length === 0)!
  const line = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => String(x.props.children).includes('into dollars')))

  // Sats under the conversion minimum stay as sats until the balance crosses it.
  test('counts leftover sats as waiting to turn into dollars', async () => {
    dollarWallet(1_000)
    expect(texts(await render())).toContain(`${formatSats(1_000)} sats waiting to turn into dollars`)
  })

  test('opens the dollar wallet, where the mode is explained and switched', async () => {
    dollarWallet(0)
    const tree = await render()
    await ReactTestRenderer.act(async () => line(tree)!.props.onPress())
    expect(mockNavigate).toHaveBeenCalledWith('StableBalance')
  })

  // With no rate the hero falls back to sats, and the green alone would be the only sign of the mode.
  test('stays when no rate has loaded and the hero falls back to sats', async () => {
    dollarWallet(0)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const shown = texts(await render())
    expect(shown.some(text => text.startsWith('$'))).toBe(false)
    expect(shown).toContain('Bitcoin you receive turns into dollars')
  })

  // With only USDB held, Convert stays hidden whatever the rates did.
  test('keeps Convert hidden when no rate has loaded', async () => {
    dollarWallet(0)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    expect(texts(await render())).not.toContain('Convert')
  })

  // A token other than USDB can become dollars, which is the one conversion the mode allows.
  test('shows Convert when a token other than USDB is held', async () => {
    mockSparkWallet(0, [
      { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
      { identifier: 'btkn1other', ticker: 'OTH', name: 'Other', decimals: 8, balanceBaseUnits: 100_000_000 },
    ])
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true
    expect(texts(await render())).toContain('Convert')
  })

  // Sats waiting to become dollars are the mode's to convert, not a choice for Convert.
  test('keeps Convert hidden with only USDB and sats waiting', async () => {
    dollarWallet(1_000)
    expect(texts(await render())).not.toContain('Convert')
  })

  test('keeps Convert hidden when the other token is at zero', async () => {
    mockSparkWallet(0, [
      { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
      { identifier: 'btkn1other', ticker: 'OTH', name: 'Other', decimals: 8, balanceBaseUnits: 0 },
    ])
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true
    expect(texts(await render())).not.toContain('Convert')
  })

  // Under a cent of a pegged token is the remainder a conversion leaves, below any minimum.
  test('keeps Convert hidden for a pegged token remainder under a cent, and shows it for a real balance', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = true
    const withDepix = (base: number) =>
      mockSparkWallet(0, [
        { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
        { identifier: DEPIX.identifier, ticker: 'DePix', name: 'Decentralized PIX', decimals: 8, balanceBaseUnits: base },
      ])
    withDepix(440_000)
    expect(texts(await render())).not.toContain('Convert')
    withDepix(100_000_000)
    expect(texts(await render())).toContain('Convert')
  })

  test('with the balance hidden, states the mode without the amount', async () => {
    dollarWallet(1_000)
    const tree = await render()
    await ReactTestRenderer.act(async () => eye(tree).props.onPress())
    const shown = texts(tree)
    expect(shown).toContain('Bitcoin you receive turns into dollars')
    expect(shown.some(text => text.includes(formatSats(1_000)))).toBe(false)
  })
})

describe('the card that asks to confirm the recovery phrase', () => {
  const cardShown = (tree: ReactTestRenderer.ReactTestRenderer) =>
    texts(tree).includes(i18n.t('backup.verifyTitle'))

  beforeEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    mockNavigate.mockClear()
  })

  test('shows with a balance and the mark, and opens the recovery phrase', async () => {
    await markUnconfirmed('primary')
    mockSparkWallet(21_000)
    const tree = await render()
    await ReactTestRenderer.act(async () => undefined)
    expect(cardShown(tree)).toBe(true)
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(BackupCard).props.onPress()
    })
    expect(mockNavigate).toHaveBeenCalledWith('RecoveryPhrase')
  })

  test('shows with a token and no sats', async () => {
    await markUnconfirmed('primary')
    mockSparkWallet(0, [{ ...USDB, balanceBaseUnits: 5_000_000 } as unknown as SparkToken])
    const tree = await render()
    await ReactTestRenderer.act(async () => undefined)
    expect(cardShown(tree)).toBe(true)
  })

  test('stays away at zero, where nothing can be lost, and the mark stays', async () => {
    await markUnconfirmed('primary')
    mockSparkWallet(0)
    const tree = await render()
    await ReactTestRenderer.act(async () => undefined)
    expect(cardShown(tree)).toBe(false)
    expect(await isUnconfirmed('primary')).toBe(true)
  })

  test('stays away for a wallet without the mark', async () => {
    mockSparkWallet(21_000)
    const tree = await render()
    await ReactTestRenderer.act(async () => undefined)
    expect(cardShown(tree)).toBe(false)
  })

  test('stays away while the balance waits for the first sync', async () => {
    await markUnconfirmed('primary')
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'waiting', recoverableSat: 0, balanceSat: 0, tokens: [] })
    const tree = await render()
    await ReactTestRenderer.act(async () => undefined)
    expect(cardShown(tree)).toBe(false)
  })

  test('lights on a stored figure the sync never confirmed, since the card states no amount', async () => {
    await markUnconfirmed('primary')
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 21_000, tokens: [] })
    const tree = await render()
    await ReactTestRenderer.act(async () => undefined)
    expect(cardShown(tree)).toBe(true)
  })
})

test('places the pending funds card a section away from the balance', async () => {
  const tree = await render()
  const card = tree.root.findByType(UnclaimedDepositsCard)
  expect(StyleSheet.flatten(card.props.style).marginTop).toBe(space.xxl)
})

// The section title and the add row are the shared pieces History and Wallets draw, so the three
// screens cannot drift apart.
test('titles the assets with SectionLabel and adds one through AddRow', async () => {
  mockSparkWallet(21_000)
  const tree = await render()

  expect(tree.root.findAllByType(SectionLabel).map(n => n.props.children)).toEqual(['Assets'])
  expect(tree.root.findAllByType(AddRow).map(n => n.props.label)).toEqual(['Add asset'])
})

describe('the two rows the 44pt floor would move rather than only grow', () => {
  // The last two of these in the app. Both are full-width rows with no flexible child inside, so
  // Touch centring its contents would send them away from the edge they belong at. One line of style
  // holds each, and this holds the line.
  // The pressable that carries the drawn style, rather than a component that wraps it, as AddRow does.
  const styleOf = (tree: ReactTestRenderer.ReactTestRenderer, label: string) => {
    const node = tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
      .find(n => n.findAllByType(Text).some(x => x.props.children === label))!
    const raw = node.props.style
    return Object.assign(
      {},
      ...[typeof raw === 'function' ? raw({ pressed: false }) : raw]
        .flat(Infinity)
        .filter(x => x && typeof x === 'object'),
    )
  }

  test('Convert stays at the right of its header', async () => {
    mockSparkWallet(21_000)
    expect(styleOf(await render(), 'Convert').justifyContent).toBe('flex-end')
  })

  test('Add asset stays at the left, under the list it adds to', async () => {
    mockSparkWallet(21_000)
    expect(styleOf(await render(), 'Add asset').justifyContent).toBe('flex-start')
  })

  // Laid across, the floor's own centring runs along the row, so the cross axis falls back to
  // stretch and the text rides at the top of the 44pt box, above the section title beside it.
  test.each(['Convert', 'Add asset'])('%s stays centred on the line it sits on', async label => {
    mockSparkWallet(21_000)
    expect(styleOf(await render(), label).alignItems).toBe('center')
  })
})

// The header row and Add asset line up with the card's own edges on the 24pt gutter, rather than 4pt
// inside it as the primitives sit on other screens.
describe('the asset header and Add asset on the gutter', () => {
  const SIDES = [
    'paddingHorizontal',
    'paddingLeft',
    'paddingRight',
    'paddingStart',
    'paddingEnd',
    'marginHorizontal',
    'marginLeft',
    'marginRight',
    'marginStart',
    'marginEnd',
  ]
  const inset = (style: Record<string, unknown>) =>
    Object.fromEntries(SIDES.filter(side => (style[side] ?? 0) !== 0).map(side => [side, style[side]]))
  const flatOf = (raw: unknown): Record<string, unknown> =>
    Object.assign(
      {},
      ...[typeof raw === 'function' ? raw({ pressed: false }) : raw].flat(Infinity).filter(x => x && typeof x === 'object'),
    )
  // The pressable a control draws, found by its text.
  const control = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
      .find(n => n.findAllByType(Text).some(x => x.props.children === label))!

  test('the section label, Convert and Add asset carry no horizontal inset', async () => {
    mockSparkWallet(21_000)
    const tree = await render()
    const label = tree.root.findAllByType(Text).find(n => n.props.children === 'Assets')!
    expect(inset(flatOf(label.props.style))).toEqual({})
    expect(inset(flatOf(control(tree, 'Convert').props.style))).toEqual({})
    expect(inset(flatOf(control(tree, 'Add asset').props.style))).toEqual({})
  })

  // SectionLabel starts on the card's edge everywhere, so a style here would undo an inset that does
  // not exist, and its comment would tell the next reader that one does.
  test('the section label is drawn as it comes, with nothing taken off', async () => {
    mockSparkWallet(21_000)
    const tree = await render()
    expect(tree.root.findByType(SectionLabel).props.style).toBeUndefined()
  })

  test('Done, which takes the place of Convert while editing, carries none either', async () => {
    mockSparkWallet(21_000)
    const tree = await render()
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetList).props.onEnterEdit())
    expect(inset(flatOf(control(tree, i18n.t('home.done')).props.style))).toEqual({})
  })

  test("the skeleton's header bar sits on the same edge", async () => {
    jest.mocked(sparkGetWalletInfo).mockReturnValueOnce(new Promise(() => undefined))
    const tree = await render()
    const bars = tree.root.findAllByType(Skeleton).filter(n => n.props.width === 72)
    expect(bars).toHaveLength(1)
    expect(inset(flatOf(bars[0]!.props.style))).toEqual({})
  })
})

// A hide that was not written comes back on the next read, so the row is put back at once and the
// screen says why, rather than let it reappear later with no word.
describe('hiding an asset', () => {
  const rowsOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
    (tree.root.findByType(AssetList).props.assets as { assetId: string }[]).map(row => row.assetId)
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await ReactTestRenderer.act(async () => {
        await Promise.resolve()
      })
    }
  }
  const editing = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetList).props.onEnterEdit())
  }
  const hide = async (tree: ReactTestRenderer.ReactTestRenderer, assetId: string) => {
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetList).props.onRemove(assetId))
    await settle()
  }
  // The lists belong to the wallet in front, so with one listed a hide is written.
  const walletInFront = () =>
    RNFS.writeFile(
      `${RNFS.DocumentDirectoryPath}/wallets.json`,
      JSON.stringify({ active: 'primary', wallets: [{ id: 'primary', fingerprint: 'fp-primary' }] }),
      'utf8',
    )

  beforeEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    mockSparkWallet(21_000)
  })

  test('a hide the lists refused puts the row back where it stood, and says so', async () => {
    // A held token after it, so the row hidden is in the middle and its place is not the end.
    mockSparkWallet(21_000, [
      { identifier: 'tkn1', ticker: 'USDs', name: 'Spark USD', decimals: 6, balanceBaseUnits: 1_500_000 },
    ])
    // No wallet in front, so the lists refuse the change.
    const tree = await render()
    await editing(tree)
    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID, USDB.identifier, 'tkn1'])

    await hide(tree, USDB.identifier)

    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID, USDB.identifier, 'tkn1'])
    expect(texts(tree)).toContain(i18n.t('home.hideFailed'))
  })

  test('a hide that holds takes the row away with no word', async () => {
    await walletInFront()
    const tree = await render()
    await editing(tree)

    await hide(tree, USDB.identifier)

    expect(rowsOf(tree)).not.toContain(USDB.identifier)
    expect(texts(tree)).not.toContain(i18n.t('home.hideFailed'))
  })

  test('the line goes with the next hide that holds, and with Done', async () => {
    const tree = await render()
    await editing(tree)
    await hide(tree, USDB.identifier)
    expect(texts(tree)).toContain(i18n.t('home.hideFailed'))

    await walletInFront()
    await hide(tree, USDB.identifier)
    expect(texts(tree)).not.toContain(i18n.t('home.hideFailed'))

    await RNFS.unlink(`${RNFS.DocumentDirectoryPath}/wallets.json`)
    await hide(tree, DEPIX.identifier)
    expect(texts(tree)).toContain(i18n.t('home.hideFailed'))
    const done = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('home.done')))!
    await ReactTestRenderer.act(async () => done.props.onPress())
    expect(texts(tree)).not.toContain(i18n.t('home.hideFailed'))
  })

  // A hide whose refusal the test lets out when it chooses.
  const heldHide = () => {
    let refuse!: () => void
    jest.mocked(removeToken).mockImplementationOnce(
      () => new Promise<void>((_, reject) => (refuse = () => reject(new Error('lists refused')))),
    )
    return async () => {
      await ReactTestRenderer.act(async () => refuse())
      await settle()
    }
  }
  const pressDone = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    const done = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('home.done')))!
    await ReactTestRenderer.act(async () => done.props.onPress())
    await settle()
  }
  const refocus = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    for (const focused of [false, true]) {
      mockFocused = focused
      await ReactTestRenderer.act(async () => {
        tree.update(<HomeScreen />)
      })
    }
    await settle()
  }

  // The refusal is about the wallet that was in front, and a switch has put another one there.
  test('a refusal that lands after a wallet switch says nothing on the next wallet', async () => {
    const tree = await render()
    await editing(tree)
    const refuse = heldHide()
    await hide(tree, USDB.identifier)
    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID])

    await ReactTestRenderer.act(async () => mockSwitchListeners.forEach(cb => cb('primary')))
    await refocus(tree)
    await refuse()

    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID, USDB.identifier])
    expect(texts(tree)).not.toContain(i18n.t('home.hideFailed'))
  })

  // A read that landed for another wallet replaced the rows, so the row is not that wallet's to get.
  test('a refusal puts no row back on the list of a wallet that came in meanwhile', async () => {
    const tree = await render()
    await editing(tree)
    const refuse = heldHide()
    await hide(tree, USDB.identifier)
    const { catalog } = await loadHomeTokens()
    jest.mocked(loadHomeTokens).mockResolvedValueOnce({ catalog, hidden: [USDB.identifier] })
    jest.mocked(sparkConnectedWalletId).mockReturnValue('other')
    try {
      await pressDone(tree)
      expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID])

      await refuse()

      expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID])
    } finally {
      jest.mocked(sparkConnectedWalletId).mockReturnValue('primary')
    }
  })

  // The read after Done brought the row back, since the hide was never written.
  test('a refusal that finds the row back already adds no second one', async () => {
    const tree = await render()
    await editing(tree)
    const refuse = heldHide()
    await hide(tree, USDB.identifier)
    await pressDone(tree)
    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID, USDB.identifier])

    await refuse()

    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID, USDB.identifier])
    expect(texts(tree)).toContain(i18n.t('home.hideFailed'))
  })

  test('the line goes with a wallet switch', async () => {
    const tree = await render()
    await editing(tree)
    await hide(tree, USDB.identifier)
    expect(texts(tree)).toContain(i18n.t('home.hideFailed'))

    await ReactTestRenderer.act(async () => mockSwitchListeners.forEach(cb => cb('primary')))
    await refocus(tree)

    expect(rowsOf(tree)).toEqual([BITCOIN_ASSET_ID, USDB.identifier])
    expect(texts(tree)).not.toContain(i18n.t('home.hideFailed'))
  })

  // A load on focus closes the editor and leaves the line, which the next Edit then takes away.
  test('the line goes when Edit opens again', async () => {
    const tree = await render()
    await editing(tree)
    await hide(tree, USDB.identifier)
    await refocus(tree)
    expect(tree.root.findByType(AssetList).props.editing).toBe(false)
    expect(texts(tree)).toContain(i18n.t('home.hideFailed'))

    await editing(tree)

    expect(texts(tree)).not.toContain(i18n.t('home.hideFailed'))
  })
})

describe('the balance label row', () => {
  // The eye is the only target in the row, so its box sets the row's height, and at the 44pt floor
  // it would hold the label a full step away from the balance it names.
  test('draws the eye below the floor and reaches 44 by hit slop, above as well as below', async () => {
    mockSparkWallet(21_000)
    const tree = await render()
    const eye = tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
      .find(n => n.findAllByType(Text).length === 0)!
    const style = Object.assign(
      {},
      ...[eye.props.style({ pressed: false })].flat(Infinity).filter(x => x && typeof x === 'object'),
    )
    expect(style.minHeight).toBeLessThan(touch.min)
    // The balance toggle below sits on top, so the slop under the eye only reaches across the gap.
    expect(style.minHeight + eye.props.hitSlop + space.sm).toBeGreaterThanOrEqual(touch.min)
  })
})

// At the largest iOS text size the balance broke in the middle of the number ("R$ / 76,6 / 1"). Every
// figure the hero draws is one paragraph on one line that shrinks to fit, whichever figure leads.
describe('at the largest text size', () => {
  const start = Dimensions.get('window')
  const usdb: SparkToken = {
    identifier: USDB.identifier,
    ticker: 'USDB',
    name: 'Bitcoin USD',
    decimals: 6,
    balanceBaseUnits: 10_000_000,
  }

  beforeEach(() => {
    const window = { ...start, fontScale: 3.12 }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  })
  afterEach(() => {
    ReactTestRenderer.act(() => Dimensions.set({ window: start, screen: start }))
  })

  // The text a figure sits in, which for a value beside its unit is the paragraph holding both.
  function paragraphsWithDigits(tree: ReactTestRenderer.ReactTestRenderer) {
    const found = new Set<ReactTestRenderer.ReactTestInstance>()
    for (const node of tree.root.findAllByType(Text)) {
      const own = [node.props.children].flat().filter((c): c is string => typeof c === 'string')
      if (!own.some(c => /\d/.test(c))) {
        continue
      }
      let top = node
      for (let up = node.parent; up; up = up.parent) {
        if (up.type === Text) {
          top = up
        }
      }
      found.add(top)
    }
    return [...found]
  }

  test.each([
    ['the bitcoin balance', 17_920, [], false],
    ['the total of every holding', 17_920, [usdb], false],
    ['the dollar wallet', 0, [usdb], true],
  ] as const)('keeps every figure on one line for %s', async (_, sats, tokens, dollar) => {
    mockSparkWallet(sats, [...tokens])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    mockDollarMode = dollar

    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <FontScaleProvider>
          <HomeScreen />
        </FontScaleProvider>,
      )
    })

    const figures = paragraphsWithDigits(tree)
    expect(figures.length).toBeGreaterThanOrEqual(dollar ? 1 : 2)
    for (const figure of figures) {
      expect(figure.props.numberOfLines).toBe(1)
      expect(figure.props.adjustsFontSizeToFit).toBe(true)
    }
  })
})

// Side by side at the largest text size, "Envi / ar" and "Rec / ebe / r" broke inside the word and
// Convert left the screen. Too narrow for both, the actions stack across the screen, each label on one
// line, and the assets header wraps.
describe('the actions at large text', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  const actions = (tree: ReactTestRenderer.ReactTestRenderer) => {
    const send = tree.root
      .findAll(node => node.props.label === i18n.t('home.send') && node.props.singleLine !== undefined)
      .at(0)!
    let box = send.parent!
    while (box.parent && !box.findAll(n => n.props.label === i18n.t('scan.title')).length) {
      box = box.parent
    }
    return { send, box }
  }

  test('stack across the screen with one-line labels when the text is large', async () => {
    mockSparkWallet(17_920)
    setScale(3.12)
    const tree = await render()
    const { send, box } = actions(tree)
    expect(send.props.singleLine).toBe(true)
    expect(StyleSheet.flatten(box.props.style).flexDirection).toBe('column')
    const header = tree.root
      .findAllByType(SectionLabel)
      .map(label => StyleSheet.flatten(label.parent!.props.style))
      .find(style => style.justifyContent === 'space-between')
    expect(header?.flexWrap).toBe('wrap')
  })

  test('sit side by side, with the scan between them, at the standard sizes', async () => {
    mockSparkWallet(17_920)
    setScale(1)
    const tree = await render()
    const { send, box } = actions(tree)
    expect(send.props.singleLine).toBe(true)
    expect(StyleSheet.flatten(box.props.style).flexDirection).toBe('row')
  })
})

// On iOS a line box no taller than its font size cuts what rises above it: the top of Hindi vowel
// signs, Thai tone marks and Vietnamese stacked accents, and the digits on the same line with them.
// The total label and the line under the balance were drawn that way.
describe('the balance block', () => {
  const tight = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByType(Text)
      .map(node => StyleSheet.flatten(node.props.style) ?? {})
      .filter(style => style.lineHeight != null && style.lineHeight <= (style.fontSize ?? 0))

  // The line under the figure is read off its own node, since a line left with no lineHeight at all
  // would pass the check on every line.
  const lineBox = (tree: ReactTestRenderer.ReactTestRenderer, line: string) => {
    const node = tree.root.findAllByType(Text).find(text => text.props.children === line)
    return StyleSheet.flatten(node?.props.style) ?? {}
  }

  // Each hero draws that line in a branch of its own, both under the one style, so a wallet is built
  // for each and the line it must show is named, which also proves which hero a test is looking at.
  async function everyLineLeads(
    tree: ReactTestRenderer.ReactTestRenderer,
    fiatLine: string,
  ): Promise<void> {
    expect(texts(tree)).toContain(i18n.t('home.balance'))
    expect(texts(tree)).toContain(fiatLine)
    expect(tight(tree)).toEqual([])
    expect(lineBox(tree, fiatLine).lineHeight).toBeGreaterThan(lineBox(tree, fiatLine).fontSize ?? 0)

    const eye = tree.root.findAllByType(Touch).find(node => node.props.label === 'Hide')!
    await ReactTestRenderer.act(async () => eye.props.onPress())
    expect(texts(tree)).toContain('••••••')
    expect(texts(tree)).not.toContain(fiatLine)
    expect(tight(tree)).toEqual([])
    expect(lineBox(tree, '••••').lineHeight).toBeGreaterThan(lineBox(tree, '••••').fontSize ?? 0)
  }

  test('gives every line of the sats hero more height than its font size, shown or hidden', async () => {
    mockSparkWallet(3_062)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    const tree = await render()
    expect(texts(tree)).toContain('sats')
    await everyLineLeads(tree, 'R$16.84')
  })

  test('gives every line of the portfolio hero more height than its font size, shown or hidden', async () => {
    mockSparkWallet(3_062, [
      { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
    ])
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
    jest.mocked(loadHeroUnit).mockResolvedValueOnce('fiat')
    const tree = await render()
    expect(texts(tree)).not.toContain('sats')
    await everyLineLeads(
      tree,
      i18n.t('home.inBitcoin', { amount: `${formatSats(3_062)} ${i18n.t('common.sats')}` }),
    )
  })
})

// "Total Balance" stood over the skeleton before the app knew whether the figure would value every
// holding, so it could name a figure that turned out to be the bitcoin balance. The label waits with
// the figure, as part of the skeleton, and a failed connect has no figure for it to name.
describe('the balance label', () => {
  const labels = [i18n.t('home.balance'), i18n.t('home.bitcoinBalance')]

  test('is a bar of the skeleton until the figure it names is known', async () => {
    jest.mocked(sparkGetWalletInfo).mockReturnValueOnce(new Promise(() => undefined))
    const tree = await render()
    expect(texts(tree).filter(text => labels.includes(text))).toEqual([])
    const bars = tree.root.findAllByType(Skeleton).map(bar => [bar.props.width, bar.props.height])
    // As tall as the label's own line, so nothing moves when the text replaces it.
    expect(bars).toContainEqual([112, font.leading.base * Dimensions.get('window').fontScale])
  })

  // One line box for every unit keeps the page still when the figure changes unit. Left to each unit,
  // the sats paragraph would take the engine's line, the currency one the 48pt leading, and the
  // skeleton that leading too.
  test('the figure keeps one line box in every unit, and the skeleton takes that box', async () => {
    mockSparkWallet(5_000)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000 })
    const tree = await render()
    const hero = () =>
      tree.root.findAllByType(Touch).find(node => labels.some(label => String(node.props.label).startsWith(label)))!
    const boxes = new Map<string, { lineHeight?: unknown; minHeight?: unknown }>()
    for (let tap = 0; tap < 3; tap++) {
      const { lineHeight, minHeight } = StyleSheet.flatten(hero().findAllByType(Text)[0].props.style)
      boxes.set(String(hero().props.label), { lineHeight, minHeight })
      await ReactTestRenderer.act(async () => hero().props.onPress())
    }
    const [first, ...others] = [...boxes.values()]

    expect(boxes.size).toBe(3)
    expect(others).toEqual([first, first])
    expect(first.minHeight).toBe(font.leading.display)

    jest.mocked(sparkGetWalletInfo).mockReturnValueOnce(new Promise(() => undefined))
    const waiting = await render()
    const bars = waiting.root.findAllByType(Skeleton).map(bar => bar.props.height)
    expect(bars).toContain(font.leading.display * Dimensions.get('window').fontScale)
  })

  test('waits through a first sync as well', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'waiting', recoverableSat: 0, balanceSat: 5_000, tokens: [] })
    const tree = await render()
    expect(texts(tree).filter(text => labels.includes(text))).toEqual([])
  })

  test('names the figure once it arrives', async () => {
    mockSparkWallet(5_000)
    jest.mocked(loadDisplayCurrency).mockResolvedValue('USD')
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    const tree = await render()
    expect(texts(tree).filter(text => labels.includes(text))).toEqual([i18n.t('home.balance')])
  })

  test('is absent when the connect fails, since there is no figure to name', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('spark unreachable'))
    const tree = await render()
    expect(texts(tree)).toContain('Could not connect to the wallet.')
    expect(texts(tree).filter(text => labels.includes(text))).toEqual([])
  })
})

describe('the way to the dollar wallet from Home', () => {
  const held = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree)
  const usdb = (balanceBaseUnits: number): SparkToken =>
    ({
      identifier: USDB.identifier,
      ticker: 'USDB',
      name: 'Bitcoin USD',
      decimals: 6,
      balanceBaseUnits,
    } as SparkToken)

  async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
    const control = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === label))
    if (!control) {
      throw new Error(`not found: ${label}`)
    }
    await ReactTestRenderer.act(async () => {
      control.props.onPress()
    })
  }

  async function settle(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await ReactTestRenderer.act(async () => {
        await Promise.resolve()
      })
    }
  }

  beforeEach(() => {
    jest.mocked(connectActiveSpark).mockResolvedValue(undefined)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    jest.mocked(loadDollarInviteSeen).mockResolvedValue(0)
    jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue({
      handle: 'q',
      spentBaseUnits: 5000,
      receivedBaseUnits: 4_950_000,
      feeBaseUnits: 0,
    })
    mockDollarMode = false
  })

  afterEach(() => {
    mockDollarMode = false
    jest.mocked(sparkConnectedWalletId).mockReturnValue('primary')
  })

  test('with sats and the mode off, the line opens the sheet and the second tap converts', async () => {
    mockSparkWallet(5000)
    const tree = await render()
    await settle()

    await press(tree, 'Keep it in dollars')
    await settle()
    expect(held(tree)).toContain(i18n.t('stable.confirmOnTitle'))
    expect(sparkSetStableBalance).not.toHaveBeenCalled()

    const sheet = tree.root.findByType(Modal)
    const convert = sheet
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('stable.confirmOnCta')))
    await ReactTestRenderer.act(async () => {
      convert?.props.onPress()
    })
    await settle()
    expect(sparkSetStableBalance).toHaveBeenCalledWith(true)
  })

  test('a new wallet with nothing to hold is offered nothing', async () => {
    mockSparkWallet(0)
    const tree = await render()
    await settle()

    expect(held(tree)).not.toContain('Keep it in dollars')
  })

  test('a figure not synced offers nothing', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 5000, tokens: [usdb(2_000_000)] })
    const tree = await render()
    await settle()

    expect(held(tree)).not.toContain('Keep it in dollars')
    expect(held(tree)).not.toContain(i18n.t('home.dollarInviteTitle'))
  })

  // The switch moves the connected wallet, so with none connected there is nothing to offer.
  test('with no wallet connected Home gets neither the line nor the invitation', async () => {
    jest.mocked(sparkConnectedWalletId).mockReturnValue(null)
    mockSparkWallet(5000, [usdb(2_000_000)])
    const tree = await render()
    await settle()

    expect(held(tree)).not.toContain('Keep it in dollars')
    expect(held(tree)).not.toContain(i18n.t('home.dollarInviteTitle'))
  })

  test('the mode on shows neither', async () => {
    mockDollarMode = true
    mockSparkWallet(5000, [usdb(2_000_000)])
    const tree = await render()
    await settle()

    expect(held(tree)).not.toContain('Keep it in dollars')
    expect(held(tree)).not.toContain(i18n.t('home.dollarInviteTitle'))
  })

  test('the invitation turns nothing on: it opens the same sheet, and cancelling remembers the figure', async () => {
    mockSparkWallet(5000, [usdb(2_000_000)])
    const tree = await render()
    await settle()

    await press(tree, i18n.t('home.dollarInviteOpen'))
    await settle()
    expect(held(tree)).toContain(i18n.t('stable.confirmOnTitle'))
    expect(sparkSetStableBalance).not.toHaveBeenCalled()

    await press(tree, i18n.t('stable.confirmCancel'))
    await settle()

    expect(saveDollarInviteSeen).toHaveBeenCalledWith('primary', 2_000_000)
    expect(held(tree)).not.toContain(i18n.t('home.dollarInviteTitle'))
  })

  test('Not now remembers the figure, and only more USDB brings it back', async () => {
    mockSparkWallet(5000, [usdb(2_000_000)])
    const tree = await render()
    await settle()

    await press(tree, i18n.t('home.dollarInviteLater'))
    await settle()
    expect(saveDollarInviteSeen).toHaveBeenCalledWith('primary', 2_000_000)
    expect(held(tree)).not.toContain(i18n.t('home.dollarInviteTitle'))

    jest.mocked(loadDollarInviteSeen).mockResolvedValue(2_000_000)
    const same = await render()
    await settle()
    expect(held(same)).not.toContain(i18n.t('home.dollarInviteTitle'))

    mockSparkWallet(5000, [usdb(3_000_000)])
    const more = await render()
    await settle()
    expect(held(more)).toContain(i18n.t('home.dollarInviteTitle'))
  })

  test('a token that only shares the name invites nobody', async () => {
    mockSparkWallet(5000, [{ ...usdb(2_000_000), identifier: 'btkn1lookalike' }])
    const tree = await render()
    await settle()

    expect(held(tree)).not.toContain(i18n.t('home.dollarInviteTitle'))
  })
})

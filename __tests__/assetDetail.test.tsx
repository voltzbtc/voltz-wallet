import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, Text } from 'react-native'
import { Txt } from '../src/components/Txt'
import { figuresHeldOut, figuresIn, flat, hostParent, textOf } from './support/figureFit'
import { FigureRow } from '../src/components/FigureRow'
// Rendering the screen in isolation bypasses App.tsx, so without this import t() returns raw keys.
import i18n from '../src/i18n'
import { AssetDetailScreen } from '../src/screens/AssetDetailScreen'
import { PRICE_CARD_HEIGHT, PriceCard } from '../src/components/PriceCard'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'
import RNFS from 'react-native-fs'
import { RecoveryMethod } from '@breeztech/breez-sdk-spark-react-native'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { planOf, recoveryOf } from './support/exitFixtures'
import { formatSats } from '../src/wallet/amount'
import { DEPIX, USDB } from '../src/wallet/tokens'
import { formatFiat } from '../src/wallet/fiat'
import { clearsAt } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import { loadDisplayCurrency } from '../src/wallet/settings'
import { Skeleton } from '../src/components/Skeleton'
import { DirectionBadge } from '../src/components/DirectionBadge'
import { SectionLabel } from '../src/components/SectionLabel'
import { TransactionDetailSheet } from '../src/components/TransactionDetailSheet'
import { colors } from '../src/theme'
import {
  connectActiveSpark,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  sparkListHistory,
  type SparkToken,
} from '../src/wallet/spark'
import { fetchBtcPriceSeries } from '../src/wallet/price'
import type { HistoryItem } from '../src/wallet/payment'

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => 'primary',
  sparkLeafIsCooperative: jest.requireActual('../src/wallet/spark').sparkLeafIsCooperative,
  onSparkSynced: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  connectActiveSpark: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkListHistory: jest.fn(),
  sparkSubscribeToPayments: jest.fn(async (cb: () => void) => {
    mockPayment.fire = cb
    return () => undefined
  }),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

const mockPayment: { fire?: () => void } = {}
const mockSwitch: { fire?: () => void } = {}
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: (cb: () => void) => {
    mockSwitch.fire = cb
    return () => undefined
  },
}))

jest.mock('../src/wallet/settings', () => ({
  ...jest.requireActual('../src/wallet/settings'),
  loadDisplayCurrency: jest.fn(async () => 'BRL'),
}))

jest.mock('../src/wallet/price', () => {
  const actual = jest.requireActual('../src/wallet/price')
  return { ...actual, fetchBtcPriceSeries: jest.fn() }
})

const mockNavigate = jest.fn()
const mockGoBack = jest.fn()
// A fresh navigation object per render would rebuild load() and loop the focus effect forever.
const mockNavigation = { navigate: mockNavigate, goBack: mockGoBack }
let mockParams: { assetId: string; name: string } = { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin' }

jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useRoute: () => ({ params: mockParams }),
    useFocusEffect: (callback: () => void) => react.useEffect(callback, [callback]),
  }
})

const usdbToken: SparkToken = {
  identifier: USDB.identifier,
  name: USDB.name,
  ticker: USDB.ticker,
  decimals: USDB.decimals,
  balanceBaseUnits: 42_500_000, // 42.5 USDB
}

const btcReceive: HistoryItem = {
  id: 'btc-1',
  direction: 'received',
  status: 'complete',
  amountSat: 12_000,
  feesSat: 0,
  timestamp: 1_786_000_000,
  asset: null,
}

const tokenSend: HistoryItem = {
  id: 'usdb-1',
  direction: 'sent',
  status: 'complete',
  amountSat: 0,
  feesSat: 0,
  timestamp: 1_786_100_000,
  asset: { assetId: USDB.identifier, ticker: 'USDB', amount: '10' },
}

const series = [
  { t: 1_786_000_000_000, v: 300_000 },
  { t: 1_786_100_000_000, v: 330_000 },
]

beforeEach(() => {
  jest.clearAllMocks()
  mockParams = { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin' }
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 1_243_500, tokens: [usdbToken] })
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 330_000, USD: 63_000 })
  jest.mocked(sparkListHistory).mockResolvedValue([btcReceive, tokenSend])
  jest.mocked(fetchBtcPriceSeries).mockResolvedValue(series)
  jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
})

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AssetDetailScreen />)
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

// A payment landing, past the screen's own debounce of a burst of them.
async function refresh(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    mockPayment.fire?.()
    await new Promise<void>(resolve => setTimeout(resolve, 650))
  })
}

function priceCards(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root.findAllByType(PriceCard)
}

function pressLabel(tree: ReactTestRenderer.ReactTestRenderer, label: string): void {
  // Pressable renders as a plain View on RN 0.86, so buttons are found by onPress plus label.
  const node = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
    .find(n => JSON.stringify(n.props.accessibilityLabel ?? '') === JSON.stringify(label))
  if (!node) {
    throw new Error(`no button labelled ${label}`)
  }
  ReactTestRenderer.act(() => node.props.onPress())
}

describe('bitcoin', () => {
  it('shows the held balance and its value in the display currency', async () => {
    const tree = await render()
    const shown = texts(tree)

    expect(shown).toContain(formatSats(1_243_500))
    expect(shown).toContain('R$4,103.55')
  })

  it('draws the price chart, anchored to the SDK rate', async () => {
    const tree = await render()
    const card = priceCards(tree)[0]

    expect(card).toBeDefined()
    expect(card.props.spot).toBe(330_000)
    expect(card.props.points).toEqual(series)
    expect(fetchBtcPriceSeries).toHaveBeenCalledWith('1D', 330_000)
  })

  it('keeps the card when the curve is unavailable, showing the price alone', async () => {
    jest.mocked(fetchBtcPriceSeries).mockResolvedValue(null)
    const tree = await render()
    const card = priceCards(tree)[0]

    expect(card).toBeDefined()
    expect(card.props.points).toEqual([])
    expect(card.props.spot).toBe(330_000)
  })

  it('survives the price source throwing, without failing the screen', async () => {
    jest.mocked(fetchBtcPriceSeries).mockRejectedValue(new Error('offline'))
    const tree = await render()

    expect(texts(tree)).toContain(formatSats(1_243_500))
    expect(priceCards(tree)[0].props.points).toEqual([])
  })

  it('drops the chart entirely when the SDK has no rate to anchor it to', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const tree = await render()

    expect(priceCards(tree)).toHaveLength(0)
    expect(fetchBtcPriceSeries).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(formatSats(1_243_500))
  })

  it('refetches the curve when the period changes, and only then', async () => {
    const tree = await render()
    expect(fetchBtcPriceSeries).toHaveBeenCalledTimes(1)

    await ReactTestRenderer.act(async () => {
      priceCards(tree)[0].props.onPeriodChange('1Y')
    })

    expect(fetchBtcPriceSeries).toHaveBeenLastCalledWith('1Y', 330_000)
    expect(fetchBtcPriceSeries).toHaveBeenCalledTimes(2)
  })

  it('asks the SDK for bitcoin payments only', async () => {
    await render()
    expect(sparkListHistory).toHaveBeenCalledWith(expect.any(Number), 'bitcoin')
  })

  it('lists only bitcoin movements, leaving the token ones out', async () => {
    const shown = texts(await render())

    expect(shown.some(text => text.startsWith('+') && text.includes(formatSats(12_000)))).toBe(true)
    expect(shown.some(text => text.includes('USDB'))).toBe(false)
  })

  it('opens send and receive on this asset', async () => {
    const tree = await render()

    pressLabel(tree, 'Send')
    expect(mockNavigate).toHaveBeenCalledWith('Send', { assetId: BITCOIN_ASSET_ID })

    pressLabel(tree, 'Receive')
    expect(mockNavigate).toHaveBeenCalledWith('Receive', { assetId: BITCOIN_ASSET_ID })
  })

  it('opens the scanner, which carries no asset: the code scanned decides it', async () => {
    const tree = await render()

    pressLabel(tree, 'Scan')
    expect(mockNavigate).toHaveBeenCalledWith('Scan')
  })
})

describe('token', () => {
  beforeEach(() => {
    mockParams = { assetId: USDB.identifier, name: USDB.name }
  })

  it('shows no chart: a dollar peg has no curve worth drawing', async () => {
    const tree = await render()

    expect(priceCards(tree)).toHaveLength(0)
    expect(fetchBtcPriceSeries).not.toHaveBeenCalled()
  })

  it('shows the token balance and its value through the peg', async () => {
    const shown = texts(await render())

    // A dollar token reads with cents, so the protocol's 42.5 shows as 42.50.
    expect(shown).toContain('42.50')
    // The peg crosses the two BTC rates, so 42.5 USD becomes 42.5 * 330000/63000.
    expect(shown).toContain('R$222.62')
  })

  it('asks the SDK for this token payments only', async () => {
    await render()
    expect(sparkListHistory).toHaveBeenCalledWith(expect.any(Number), {
      tokenIdentifier: USDB.identifier,
    })
  })

  it('shows no fiat line at all when the peg has no rate, instead of a fake "R$ 0,00"', async () => {
    // assetFiatValue returns 0 rather than null without a rate because Home sums it, but a lone 0
    // here would read as "this is worth nothing".
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 330_000 })
    const shown = texts(await render())

    // A dollar token reads with cents, so the protocol's 42.5 shows as 42.50.
    expect(shown).toContain('42.50')
    expect(shown.some(text => text.includes('R$0.00'))).toBe(false)
  })

  it('lists only this token movements', async () => {
    const shown = texts(await render())

    expect(shown.some(text => text.includes('$10.00'))).toBe(true)
    expect(shown.some(text => text.includes(formatSats(12_000)))).toBe(false)
  })
})

describe('DePix', () => {
  // Answers only the coins asked for, as sparkGetFiatRates does, so a screen that never asks for the
  // real cannot value DePix by accident.
  const RATES: Record<string, number> = { USD: 100_000, BRL: 500_000, EUR: 90_000 }
  const honestRates = async (coins: string[]) =>
    Object.fromEntries(coins.filter(coin => coin in RATES).map(coin => [coin, RATES[coin]]))

  it('values a DePix balance in another display currency through the real', async () => {
    mockParams = { assetId: DEPIX.identifier, name: 'DePix' }
    jest.mocked(loadDisplayCurrency).mockResolvedValue('USD')
    jest.mocked(sparkGetFiatRates).mockImplementation(honestRates)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [
        {
          identifier: DEPIX.identifier,
          name: DEPIX.name,
          ticker: DEPIX.ticker,
          decimals: DEPIX.decimals,
          balanceBaseUnits: 10_000_000_000, // 100 DePix
        },
      ],
    })
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const shown = texts(await render())

    // 100 reais at 500_000 BRL and 100_000 USD per bitcoin is 20 dollars.
    expect(shown.some(text => text.includes(formatFiat(20, 'USD')))).toBe(true)
  })

  // The Home row reads this as "0.00052"; the asset's own screen is where the exact figure lives.
  it('shows the exact figure of a sub-cent balance, which the list cuts short', async () => {
    mockParams = { assetId: DEPIX.identifier, name: 'DePix' }
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [
        { identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: 8, balanceBaseUnits: 52_321 },
      ],
    })
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const shown = texts(await render()).join(' ')
    expect(shown).toContain('0.00052321')
    expect(shown).not.toMatch(/0\.00052(?!321)/)
  })

  it('writes that figure with a comma in Portuguese', async () => {
    mockParams = { assetId: DEPIX.identifier, name: 'DePix' }
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [
        { identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: 8, balanceBaseUnits: 52_321 },
      ],
    })
    jest.mocked(sparkListHistory).mockResolvedValue([])
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('pt-BR')
    })
    try {
      expect(texts(await render()).join(' ')).toContain('0,00052321')
    } finally {
      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('en-US')
      })
    }
  })
})

describe('movement rows', () => {
  it('titles the activity with SectionLabel, as History titles its days', async () => {
    const tree = await render()
    expect(tree.root.findAllByType(SectionLabel).map(n => n.props.children)).toEqual([
      i18n.t('asset.activity'),
    ])
  })

  it('names a zap "Zap", like the History does, not "Received"', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, zap: { comment: 'gm' } }])
    const shown = texts(await render())

    expect(shown).toContain('Zap')
    expect(shown).not.toContain('Received')
  })

  it('marks a failed payment so it cannot pass for money that moved', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, status: 'failed' }])
    const tree = await render()

    const amount = tree.root
      .findAllByType(Text)
      .find(node => String(node.props.children ?? '').includes('12'))
    const style = Object.assign({}, ...[amount?.props.style ?? []].flat(Infinity).filter(Boolean))
    expect(style.textDecorationLine).toBe('line-through')
    expect(style.color).toBe(colors.danger)
  })

  it('draws a conversion into the asset without a minus, and a send with one', async () => {
    mockParams = { assetId: USDB.identifier, name: USDB.name }
    const converted: HistoryItem = {
      ...tokenSend,
      id: 'usdb-conv',
      direction: 'converted',
      asset: { assetId: USDB.identifier, ticker: 'USDB', amount: '25' },
    }
    jest.mocked(sparkListHistory).mockResolvedValue([converted, tokenSend])
    const shown = texts(await render()).join('|')

    expect(shown).not.toMatch(/[-\u2212]\|?25\.00 USDB/)
    expect(shown).toContain('25.00 USDB')
    // U+2212, as wide as the plus; a hyphen reads as a dash beside a figure.
    expect(shown).toMatch(/\u2212\|?\$10\.00/)
    expect(shown).not.toMatch(/-\|?\$10\.00/)
  })

  it('draws a conversion the same way History does, with what left under what arrived', async () => {
    mockParams = { assetId: USDB.identifier, name: USDB.name }
    const converted: HistoryItem = {
      ...tokenSend,
      id: 'usdb-conv',
      direction: 'converted',
      asset: { assetId: USDB.identifier, ticker: 'USDB', amount: '25.337999' },
      conversion: {
        status: 'complete',
        automatic: true,
        from: { ticker: null, amount: '31191' },
        to: { ticker: 'USDB', amount: '25.337999', fee: '0.05' },
      },
    }
    jest.mocked(sparkListHistory).mockResolvedValue([converted])
    const lines = texts(await render())

    expect(lines).toContain('Conversion to USDB')
    expect(lines).toContain('25.33 USDB')
    expect(lines).toContain(`from ${formatSats(31_191)} sats`)
  })

  // The sign travels with the amount through the locale, so a language can place it where it reads.
  it('signs a movement through the locale rather than gluing a sign before it', async () => {
    mockParams = { assetId: USDB.identifier, name: USDB.name }
    jest.mocked(sparkListHistory).mockResolvedValue([tokenSend])
    const original = i18n.t('asset.amountOut')
    i18n.addResource(i18n.language, 'translation', 'asset.amountOut', '{{amount}} out')
    try {
      const shown = texts(await render())
      expect(shown).toContain('$10.00 out')
    } finally {
      i18n.addResource(i18n.language, 'translation', 'asset.amountOut', original)
    }
  })

  it('states the status on the row, like the History list', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, status: 'pending' }])
    const shown = texts(await render()).join(' ')

    expect(shown).toContain('Pending')
  })
})

describe('loading', () => {
  it("holds the price card's own height for bitcoin, read from the card rather than counted by hand", async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<AssetDetailScreen />)
    })

    const heights = tree.root.findAllByType(Skeleton).map(node => node.props.height)
    expect(heights).toContain(PRICE_CARD_HEIGHT)
  })

  it('does not promise a chart to an asset that will never have one', async () => {
    // A chart placeholder would make the USDB screen promise a chart and then jump once the data
    // landed.
    mockParams = { assetId: USDB.identifier, name: USDB.name }
    let tree!: ReactTestRenderer.ReactTestRenderer
    // An unresolved getInfo keeps the screen in its loading state.
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<AssetDetailScreen />)
    })

    const heights = tree.root.findAllByType(Skeleton).map(node => node.props.height)
    expect(heights).not.toContain(PRICE_CARD_HEIGHT)
    // Actions and movement rows are still promised, since they exist for any asset.
    expect(heights.filter(h => h === 52)).toHaveLength(3)
  })
})

describe('failure', () => {
  it('a cause it cannot name adds no line, and a replaced connect shows no error', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('rpc status 13'))
    const shown = texts(await render()).join(' ')
    expect(shown).toContain(i18n.t('home.connectionError'))
    expect(shown).not.toContain('rpc status')
    expect(shown).not.toContain('errors.unknown')

    const superseded = new Error('spark connect superseded')
    superseded.name = 'SparkConnectSuperseded'
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(superseded)
    const tree = await render()
    expect(texts(tree)).not.toContain(i18n.t('home.connectionError'))
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
  })

  // The payment words classifyWalletError also matches would name a cause that never happened.
  it.each([
    ['invalid response from the operator', 'errors.invalidInput'],
    ['session expired', 'errors.expiredInvoice'],
  ])('a connect error reading "%s" adds no payment line under the title', async (message, key) => {
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error(message))

    const shown = texts(await render())

    expect(shown).toContain(i18n.t('home.connectionError'))
    expect(shown).not.toContain(i18n.t(key))
  })

  it('a wallet whose data was deleted says so under the title', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('deleted'))

    const shown = texts(await render())

    expect(shown).toContain(i18n.t('home.connectionError'))
    expect(shown).toContain(i18n.t('errors.deleted'))
  })

  it('goes back when the asset is not in the wallet anymore', async () => {
    mockParams = { assetId: 'btkn1gone', name: 'Ghost' }
    await render()

    expect(mockGoBack).toHaveBeenCalled()
  })

  // The cause is stated as a translated code, never as the SDK's raw text.
  it('shows the connection error with its cause in the app language, and retries', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('Network request failed'))
    const tree = await render()

    expect(texts(tree)).toContain(i18n.t('home.connectionError'))
    expect(texts(tree)).toContain(i18n.t('errors.offline'))
    expect(texts(tree).join(' ')).not.toContain('Network request failed')

    await ReactTestRenderer.act(async () => {
      const retry = tree.root.find(
        node =>
          typeof node.props.onPress === 'function' && node.props.accessibilityLabel === 'Try again',
      )
      retry.props.onPress()
    })

    expect(texts(tree)).toContain(formatSats(1_243_500))
  })
})

test('the balance carries the wallet accent, which is how the dollar mode shows', async () => {
  // The balance is the largest figure on this screen and the only place it says which wallet you
  // are in, orange normally and green with the dollar balance on. Without the tone it draws white,
  // which is what every other number on the screen already is.
  const tree = await render()
  // Found by being the largest text on the screen rather than by its digits, because the thousands
  // separator is locale-dependent and the amount comes from a mocked balance that may be formatted
  // either way.
  const balance = tree.root
    .findAllByType(Text)
    .map(n => ({
      node: n,
      size: Object.assign(
        {},
        ...[n.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
      ).fontSize as number | undefined,
    }))
    .filter(x => typeof x.size === 'number')
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0]?.node
  const style = Object.assign(
    {},
    ...[balance?.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
  )
  expect(style.color).toBe(colors.primary)
})

test('names the asset in its own unit, since this screen exists to show one asset', async () => {
  // The screen for a single asset, and the asset can be a token. A unit pinned to sats would show a
  // USDB balance reading "sats", which is the mistake Amount exists to stop.
  mockParams = { assetId: USDB.identifier, name: USDB.name }
  const tree = await render()
  expect(texts(tree)).toContain('USDB')
  expect(texts(tree)).not.toContain('sats')
})

// At a large text size a figure beside the labels took the whole row: the label column, laid out
// from a basis of 0, was left no width at all, and the labels broke inside their words ("Conv/erted").
describe('the activity rows at large text', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))
  // The activity's figures carry a sign, where the hero and the price card above them do not.
  const movementFigures = (tree: ReactTestRenderer.ReactTestRenderer) =>
    figuresIn(tree.root).filter(node => /^[+\u2212]/.test(textOf(node)))

  test('side by side, a figure gives way in its row and leaves the labels a share of it', async () => {
    const tree = await render()
    const figures = movementFigures(tree)
    expect(figures.length).toBeGreaterThan(0)
    expect(figuresHeldOut(tree.root)).toEqual([])
    // Each row is a FigureRow, whose figure side keeps its width up to a share of the row.
    const inRows = new Set(tree.root.findAllByType(FigureRow).flatMap(row => figuresIn(row)))
    for (const figure of figures) {
      expect(inRows.has(figure)).toBe(true)
      expect(flat(hostParent(figure))).toMatchObject({ maxWidth: '60%', flexShrink: 0 })
    }
  })

  test('too narrow for both, a figure goes under the labels, which keep the row', async () => {
    setScale(3.12)
    const tree = await render()
    const figures = movementFigures(tree)
    expect(figures.length).toBeGreaterThan(0)
    for (const figure of figures) {
      const side = hostParent(figure)
      expect(flat(side && hostParent(side)).flexDirection).toBe('column')
      expect(flat(side).maxWidth).toBe('100%')
    }
  })

  test('the labels wrap only between words', async () => {
    const tree = await render()
    const label = tree.root
      .findAllByType(Txt)
      .find(node => node.props.children === i18n.t('history.received'))
    expect(label?.props.wholeWords).toBe(true)
  })
})

// A read that failed and a wallet with no movements are different facts, and only one may be stated.
describe('the activity says what was read', () => {
  const NONE = 'No activity yet.'
  const NOT_UPDATED = 'Not yet updated with the network'

  it('a read that failed never says there is no activity', async () => {
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('storage'))
    const shown = texts(await render())

    expect(shown).not.toContain(NONE)
    expect(shown).toContain(NOT_UPDATED)
  })

  it('an empty answer on a synced connection does', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const shown = texts(await render())

    expect(shown).toContain(NONE)
    expect(shown).not.toContain(NOT_UPDATED)
  })

  it('an empty answer past the wait for a sync does not', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 1_243_500, tokens: [usdbToken] })
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const shown = texts(await render())

    expect(shown).not.toContain(NONE)
    expect(shown).toContain(NOT_UPDATED)
  })

  // The first read found the connection unsynced, and the sync came with a list that could not be read.
  it('an empty list from before the sync is no answer once the list stops answering', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 1_243_500, tokens: [usdbToken] })
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const tree = await render()
    expect(texts(tree)).toContain(NOT_UPDATED)

    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 1_243_500, tokens: [usdbToken] })
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('storage'))
    await refresh()

    expect(texts(tree)).not.toContain(NONE)
    expect(texts(tree)).toContain(NOT_UPDATED)

    // And the next read that answers on the synced connection is an answer again.
    jest.mocked(sparkListHistory).mockResolvedValue([])
    await refresh()

    expect(texts(tree)).toContain(NONE)
  })

  it('movements read before the sync stay through a read that fails', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 1_243_500, tokens: [usdbToken] })
    const tree = await render()
    expect(texts(tree).join('|')).toContain(formatSats(12_000))

    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 1_243_500, tokens: [usdbToken] })
    jest.mocked(sparkListHistory).mockRejectedValue(new Error('storage'))
    await refresh()

    expect(texts(tree).join('|')).toContain(formatSats(12_000))
  })

  it('a synced empty list stays an answer through a read that fails', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([])
    const tree = await render()
    expect(texts(tree)).toContain(NONE)

    jest.mocked(sparkListHistory).mockRejectedValue(new Error('storage'))
    await refresh()

    expect(texts(tree)).toContain(NONE)
  })

  it('a later read that fails leaves the movements on screen', async () => {
    const tree = await render()
    expect(texts(tree).join('|')).toContain(formatSats(12_000))

    jest.mocked(sparkListHistory).mockRejectedValue(new Error('storage'))
    await refresh()

    expect(texts(tree).join('|')).toContain(formatSats(12_000))
    expect(texts(tree)).not.toContain(NONE)
  })
})

describe('a movement', () => {
  const movementTouches = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(
      n =>
        n.props.accessibilityRole === 'button' &&
        typeof n.props.onPress === 'function' &&
        n.findAllByType(DirectionBadge).length > 0,
    )
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(TransactionDetailSheet)
  const open = (tree: ReactTestRenderer.ReactTestRenderer) =>
    ReactTestRenderer.act(async () => movementTouches(tree)[0]!.props.onPress())

  it('says its date as well as its time, when it is not from today', async () => {
    const march = Math.floor(new Date(2026, 2, 14, 14, 30).getTime() / 1000)
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, timestamp: march }])
    const line = texts(await render()).join('')

    expect(line).toContain(clearsAt(march, deviceDateTimePrefs()))
    expect(clearsAt(march, deviceDateTimePrefs())).toContain('2026')
  })

  it('opens the same detail as History on one tap', async () => {
    const tree = await render()
    expect(sheet(tree).props.item).toBeNull()

    await open(tree)

    expect(sheet(tree).props.item.id).toBe('btc-1')
  })

  it('that settles with the detail open changes in it', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, status: 'pending' }])
    const tree = await render()
    await open(tree)
    expect(sheet(tree).props.item.status).toBe('pending')

    jest.mocked(sparkListHistory).mockResolvedValue([{ ...btcReceive, status: 'complete' }])
    await refresh()

    expect(sheet(tree).props.item.status).toBe('complete')
  })

  it('that leaves the window keeps the detail open on its last copy', async () => {
    const tree = await render()
    await open(tree)

    const newer = Array.from({ length: 5 }, (_, index) => ({ ...btcReceive, id: `new-${index}` }))
    jest.mocked(sparkListHistory).mockResolvedValue(newer)
    await refresh()

    expect(sheet(tree).props.item.id).toBe('btc-1')
  })

  it('closes with a wallet switch', async () => {
    const tree = await render()
    await open(tree)

    await ReactTestRenderer.act(async () => mockSwitch.fire?.())

    expect(sheet(tree).props.item).toBeNull()
  })
})

describe('See all', () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...btcReceive, id: `m${index}` }))
  const seeAll = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).includes('See all')

  it('is absent with what fits in the five shown', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue(many(5))

    expect(seeAll(await render())).toBe(false)
  })

  it('opens the whole list of this asset when there is more', async () => {
    jest.mocked(sparkListHistory).mockResolvedValue(many(6))
    const tree = await render()
    expect(seeAll(tree)).toBe(true)
    const row = tree.root
      .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(node => node.props.children === 'See all'))

    ReactTestRenderer.act(() => row!.props.onPress())

    expect(mockNavigate).toHaveBeenCalledWith('AssetHistory', { assetId: BITCOIN_ASSET_ID })
  })

  it('counts only this asset', async () => {
    const others = Array.from({ length: 6 }, (_, index) => ({ ...tokenSend, id: `t${index}` }))
    jest.mocked(sparkListHistory).mockResolvedValue([btcReceive, ...others])

    expect(seeAll(await render())).toBe(false)
  })
})

// Home and this screen draw the SDK's bitcoin figure as it answers, under the same held line.
describe('while an exit is alive', () => {
  const plan = planOf({
    selection: 'all',
    recovery: recoveryOf({
      leaves: [
        { leafId: 'a', valueSats: 8_192n, method: RecoveryMethod.Unilateral },
        { leafId: 'b', valueSats: 8_192n, method: RecoveryMethod.Unilateral },
      ],
      recoverableValueSats: 16_384n,
    }),
  })

  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    __setEmergencyExitLiveForTests(true)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 24_575, tokens: [] })
    await saveExitPlan(plan)
  })

  afterEach(async () => {
    jest.restoreAllMocks()
    await forgetExitPlan('primary')
    __setEmergencyExitLiveForTests(null)
  })

  test('draws the SDK figure with nothing taken off, under the held line', async () => {
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    const shown = texts(tree).join(' ')
    expect(shown).toContain(formatSats(24_575))
    expect(shown).not.toContain(formatSats(8_191))
    expect(shown).toContain(i18n.t('emergencyExit.balanceHeld'))
  })

  // After the first confirmation and a sync the SDK already leaves the exiting leaves out.
  test('once the SDK took the leaves out itself, the figure is what the SDK says', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 8_191, tokens: [] })
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    const shown = texts(tree).join(' ')
    expect(shown).toContain(formatSats(8_191))
    expect(shown).toContain(i18n.t('emergencyExit.balanceHeld'))
  })

  test('with the plan gone nothing is said of a hold', async () => {
    await forgetExitPlan('primary')
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    expect(texts(tree).join(' ')).not.toContain(i18n.t('emergencyExit.balanceHeld'))
  })

  test('a plan the platform will not read draws the SDK figure under the held line', async () => {
    const real = RNFS.readFile
    jest
      .spyOn(RNFS, 'readFile')
      .mockImplementation((path: string, encoding?: string) =>
        path.includes('exit-plan-') ? Promise.reject(new Error('EACCES')) : real(path, encoding),
      )
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 10))
    })
    const shown = texts(tree).join(' ')
    expect(shown).toContain(formatSats(24_575))
    expect(shown).toContain(i18n.t('emergencyExit.balanceHeld'))
  })
})

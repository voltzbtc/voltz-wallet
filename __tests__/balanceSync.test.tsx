import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { ScrollView, Text } from 'react-native'
// Rendering in isolation bypasses App.tsx, so i18n must be initialized or t() returns raw keys.
import i18n from '../src/i18n'
import { PaymentStatus, PaymentType, SdkEvent_Tags } from '@breeztech/breez-sdk-spark-react-native'
import { HomeScreen } from '../src/screens/HomeScreen'
import { AssetDetailScreen } from '../src/screens/AssetDetailScreen'
import { Skeleton } from '../src/components/Skeleton'
import { GradientButton } from '../src/components/GradientButton'
import { Touch } from '../src/components/Touch'
import { AssetList } from '../src/components/AssetList'
import { SYNC_WAIT_MS, disconnectSpark, sparkGetWalletInfo } from '../src/wallet/spark'
import { Reenter } from '../src/components/Reenter'
import { LIVE_READ_EVERY_MS } from '../src/hooks/useLiveFigures'
import { motion } from '../src/theme'
import {
  addAndActivateWallet,
  removeActiveWallet,
  switchWalletWithoutReconnecting,
} from '../src/wallet/wallet'
import { getActiveWalletId, loadRegistry, setActiveWallet } from '../src/wallet/walletRegistry'
import { deleteSeedFor } from '../src/wallet/seed'
import { formatSats } from '../src/wallet/amount'
import { formatFiat, satsToFiat } from '../src/wallet/fiat'
import { USDB } from '../src/wallet/tokens'
import { loadDisplayCurrency } from '../src/wallet/settings'

// The real spark.ts runs against the mocked binding, so the synced flag is the one the app keeps.

jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(
    async () =>
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  loadPassphraseFor: jest.fn(async () => undefined),
  saveSeedFor: jest.fn(async () => undefined),
  savePassphraseFor: jest.fn(async () => undefined),
  deleteSeedFor: jest.fn(async () => undefined),
  deletePassphraseFor: jest.fn(async () => undefined),
  hasSeedFor: jest.fn(async () => true),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'wallet-a'),
  ensureRegistered: jest.fn(async () => undefined),
  setActiveWallet: jest.fn(async () => undefined),
  loadRegistry: jest.fn(async () => ({ wallets: [], active: null })),
  removeWalletEntry: jest.fn(async () => undefined),
  newWalletId: jest.fn(() => 'wallet-new'),
}))
jest.mock('../src/wallet/deletionMark', () => ({
  clearDeletionMark: jest.fn(async () => undefined),
  clearImportCheck: jest.fn(async () => undefined),
  noteImportCheck: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/walletImage', () => ({ deleteWalletImage: jest.fn(async () => undefined) }))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp'),
}))
jest.mock('../src/wallet/identitySigner', () => ({
  identitySigner: jest.fn(async () => ({ pubkey: '02aa', sign: async () => 'sig' })),
}))
jest.mock('../src/wallet/recover', () => ({
  recoverPurchases: jest.fn(async () => null),
  putBackCard: jest.fn(async () => undefined),
  forgetPurchaseAsk: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/deletion', () => ({ readDeletionOnFocus: jest.fn(async () => undefined) }))
jest.mock('../src/wallet/settings', () => ({
  ...jest.requireActual('../src/wallet/settings'),
  loadDisplayCurrency: jest.fn(async () => 'BRL'),
  forgetDollarMode: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/price', () => ({
  ...jest.requireActual('../src/wallet/price'),
  fetchBtcPriceSeries: jest.fn(async () => []),
}))
let mockStable = false
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => mockStable,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

const mockNavigation = { navigate: jest.fn(), goBack: jest.fn(), isFocused: jest.fn(() => true) }
let mockFocused = true
// Some screens hand Home a new navigation object on every render; Home must not reload for that.
let mockFreshNavigation = false
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => (mockFreshNavigation ? { ...mockNavigation } : mockNavigation),
    useRoute: () => ({
      params: { assetId: require('../src/wallet/assets').BITCOIN_ASSET_ID, name: 'Bitcoin' },
    }),
    useFocusEffect: (callback: () => void | (() => void)) =>
      react.useEffect(() => (mockFocused ? callback() : undefined), [callback, mockFocused]),
  }
})

type Listener = { onEvent: (event: unknown) => Promise<void> }
// A plain require, so this is the very instance spark.ts imports.
const binding = require('@breeztech/breez-sdk-spark-react-native') as {
  connect: jest.Mock
  __sdkInstance: {
    getInfo: jest.Mock
    addEventListener: jest.Mock
    listFiatRates: jest.Mock
    syncWallet: jest.Mock
    disconnect: jest.Mock
  }
}
const sdk = binding.__sdkInstance

// Every listener the binding was handed, and for each connect the one it registered first, which is
// the connection's own sync watcher.
let listeners: Listener[] = []
let connects: { watcher: Listener | null; from: number }[] = []

const BRL = 411_456.42
const USD = 75_000
const USDB_BASE = 22_675_500n // 22,6755 USDB

// A token added by its identifier that the app has no peg for, so no rate can value it.
const OTHER_ID = 'btkn1unpricedtokenaddedbyitsidentifier'

function info(sats: number, usdb?: bigint, other?: bigint) {
  const tokenBalances = new Map()
  if (usdb !== undefined) {
    tokenBalances.set(USDB.identifier, {
      balance: usdb,
      tokenMetadata: { ticker: USDB.ticker, name: USDB.name, decimals: USDB.decimals },
    })
  }
  if (other !== undefined) {
    tokenBalances.set(OTHER_ID, {
      balance: other,
      tokenMetadata: { ticker: 'OTH', name: 'Other token', decimals: 8 },
    })
  }
  return { identityPubkey: '02aa', balanceSats: BigInt(sats), tokenBalances }
}

// The connect path awaits a long chain of mocked native calls, so a few rounds let it land.
async function settle(ms = 0): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
  for (let i = 0; i < 10; i++) {
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(0)
    })
  }
}

// The SDK hands an event to every listener of a connection (events.rs, emit), so the one named here
// is only how a test picks the connection.
async function emitSynced(listener: Listener | null): Promise<void> {
  const connect = connects.findIndex(entry => entry.watcher === listener)
  const heard = connect < 0 ? [] : listeners.slice(connects[connect].from, connects[connect + 1]?.from)
  await ReactTestRenderer.act(async () => {
    for (const each of heard) {
      await each.onEvent({ tag: SdkEvent_Tags.Synced })
    }
  })
  // Home and the asset screen gather a burst of events for 600 ms before reloading.
  await settle(700)
}

async function render(element: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  await settle()
  return tree
}

function screenText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children
      return (Array.isArray(children) ? children : [children]).filter(
        (child): child is string | number => typeof child === 'string' || typeof child === 'number',
      )
    })
    .join(' ')
    .replace(/\s+/g, ' ')
}

const norm = (s: string) => s.replace(/\s+/g, ' ')
const MARK = 'Not yet updated with the network'
const TOTAL = 'Total Balance'
const BITCOIN = 'Bitcoin Balance'
const DOLLAR_LINE = 'Bitcoin you receive turns into dollars'
const sats = (n: number) => norm(`${formatSats(n)} sats`)
const skeletons = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(Skeleton).length

beforeEach(async () => {
  jest.useFakeTimers()
  jest.clearAllMocks()
  await disconnectSpark()
  listeners = []
  connects = []
  mockFocused = true
  mockStable = false
  mockFreshNavigation = false
  mockNavigation.isFocused.mockReturnValue(true)
  jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
  sdk.syncWallet.mockReset()
  sdk.syncWallet.mockResolvedValue({})
  jest.mocked(getActiveWalletId).mockResolvedValue('wallet-a')
  binding.connect.mockImplementation(async () => {
    connects.push({ watcher: null, from: listeners.length })
    return sdk
  })
  sdk.addEventListener.mockImplementation(async (listener: Listener) => {
    listeners.push(listener)
    const last = connects[connects.length - 1]
    if (last && last.watcher === null) {
      last.watcher = listener
    }
    return `listener_${listeners.length}`
  })
  sdk.listFiatRates.mockResolvedValue({
    rates: [
      { coin: 'BRL', value: BRL },
      { coin: 'USD', value: USD },
    ],
  })
  // The database on the device, as the last sync left it weeks ago.
  sdk.getInfo.mockResolvedValue(info(10_435))
})

afterEach(() => {
  jest.useRealTimers()
})

const control = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(ScrollView)[0].props.refreshControl

async function pull(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    control(tree).props.onRefresh()
  })
}

// The SDK hands an event to every listener (events.rs, emit), so a Synced reaches the sync watcher and
// Home's payment listener alike, and the second arms a load 600 ms later.
async function deliverSynced(): Promise<void> {
  const from = connects[connects.length - 1].from
  for (const listener of listeners.slice(from)) {
    await listener.onEvent({ tag: SdkEvent_Tags.Synced })
  }
}

const syncAnswers = (): void => {
  sdk.syncWallet.mockImplementation(async () => {
    await deliverSynced()
    return {}
  })
}

// A Synced reads for a failure, and so does the pull as it ends, both ahead of the load that follows.
const pullReadsAnswer = (): void => {
  sdk.getInfo.mockResolvedValueOnce(info(10_435)).mockResolvedValueOnce(info(10_435))
}

// The picker switches first and Home reconnects on focus.
async function switchToWalletB(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
  await ReactTestRenderer.act(async () => {
    await switchWalletWithoutReconnecting('wallet-b')
  })
  mockFocused = false
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  mockFocused = true
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  await settle()
}

// Rates come from the server on every read, so they fail and run late while the balance does not.
describe('Home with rates that fail or run late', () => {
  const totalIn = (brl: number) => norm(formatFiat(satsToFiat(3_062, brl) + 22.6755 * (brl / USD), 'BRL'))

  // A figure the rates value whole, whose hero is the total in the display currency.
  async function totalOnScreen(): Promise<ReactTestRenderer.ReactTestRenderer> {
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(totalIn(BRL))
    return tree
  }

  test('a refresh whose rates fail keeps the total, valued at the last rates', async () => {
    const tree = await totalOnScreen()

    sdk.listFiatRates.mockRejectedValue(new Error('network unreachable'))
    sdk.getInfo.mockResolvedValue(info(4_000, USDB_BASE))
    await emitSynced(connects[0].watcher)
    await settle(700)
    await ReactTestRenderer.act(async () => {
      await listeners[listeners.length - 1].onEvent({ tag: 'other' })
    })
    await settle(700)

    expect(screenText(tree)).toContain(TOTAL)
    expect(screenText(tree)).toContain(norm(formatFiat(satsToFiat(4_000, BRL) + 22.6755 * (BRL / USD), 'BRL')))
    expect(screenText(tree)).not.toContain(BITCOIN)
  })

  test('rates that answered replace the last ones, even an answer with fewer coins', async () => {
    const tree = await totalOnScreen()

    sdk.listFiatRates.mockResolvedValue({ rates: [{ coin: 'USD', value: USD }] })
    await ReactTestRenderer.act(async () => {
      await listeners[listeners.length - 1].onEvent({ tag: 'other' })
    })
    await settle(700)

    expect(screenText(tree)).toContain(BITCOIN)
  })

  test('another wallet never takes the rates the last one kept', async () => {
    const tree = await totalOnScreen()

    sdk.listFiatRates.mockRejectedValue(new Error('network unreachable'))
    await switchToWalletB(tree)
    await emitSynced(connects[1].watcher)

    expect(screenText(tree)).toContain(BITCOIN)
    expect(screenText(tree)).not.toContain(totalIn(BRL))
  })

  test('rates that never answer do not hold the first figure, and a late answer values it', async () => {
    let answer: ((value: { rates: { coin: string; value: number }[] }) => void) | undefined
    sdk.listFiatRates.mockImplementation(() => new Promise(resolve => (answer = resolve)))
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await ReactTestRenderer.act(async () => {
      await connects[0].watcher?.onEvent({ tag: SdkEvent_Tags.Synced })
    })
    await settle(599)
    expect(screenText(tree)).not.toContain(sats(3_062))

    await settle(3_000 + 1)
    expect(screenText(tree)).toContain(sats(3_062))
    expect(screenText(tree)).toContain(BITCOIN)

    await ReactTestRenderer.act(async () => {
      answer?.({
        rates: [
          { coin: 'BRL', value: BRL },
          { coin: 'USD', value: USD },
        ],
      })
    })
    await settle()
    expect(screenText(tree)).toContain(totalIn(BRL))
  })

  test('a late answer never replaces the rates a newer load read', async () => {
    let answer: ((value: { rates: { coin: string; value: number }[] }) => void) | undefined
    sdk.listFiatRates.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    const tree = await render(<HomeScreen />)
    sdk.listFiatRates.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await ReactTestRenderer.act(async () => {
      await connects[0].watcher?.onEvent({ tag: SdkEvent_Tags.Synced })
    })
    await settle(3_700)
    const older = answer

    await ReactTestRenderer.act(async () => {
      await listeners[listeners.length - 1].onEvent({ tag: 'other' })
    })
    await settle(700)
    expect(screenText(tree)).toContain(totalIn(BRL))

    await ReactTestRenderer.act(async () => {
      older?.({
        rates: [
          { coin: 'BRL', value: BRL * 2 },
          { coin: 'USD', value: USD },
        ],
      })
    })
    await settle()

    expect(screenText(tree)).toContain(totalIn(BRL))
  })

  test('a display currency chosen since starts from no rates, so it never reads an old price', async () => {
    const tree = await totalOnScreen()

    jest.mocked(loadDisplayCurrency).mockResolvedValue('USD')
    sdk.listFiatRates.mockRejectedValue(new Error('network unreachable'))
    await ReactTestRenderer.act(async () => {
      await listeners[listeners.length - 1].onEvent({ tag: 'other' })
    })
    await settle(700)

    expect(screenText(tree)).toContain(BITCOIN)
  })

  test('a late answer about the previous wallet lands nothing', async () => {
    let answer: ((value: { rates: { coin: string; value: number }[] }) => void) | undefined
    sdk.listFiatRates.mockImplementation(() => new Promise(resolve => (answer = resolve)))
    const tree = await render(<HomeScreen />)
    await ReactTestRenderer.act(async () => {
      await connects[0].watcher?.onEvent({ tag: SdkEvent_Tags.Synced })
    })
    await settle(3_700)
    const stranger = answer

    sdk.listFiatRates.mockResolvedValue({ rates: [] })
    sdk.getInfo.mockResolvedValue(info(50))
    await switchToWalletB(tree)
    await emitSynced(connects[1].watcher)
    await ReactTestRenderer.act(async () => {
      stranger?.({ rates: [{ coin: 'BRL', value: BRL }] })
    })
    await settle()

    expect(screenText(tree)).toContain(sats(50))
    expect(screenText(tree)).not.toContain(norm(formatFiat(satsToFiat(50, BRL), 'BRL')))
  })
})

// Two reads can be out at once, and only the one started last may paint.
describe('Home with two loads out', () => {
  const event = async (): Promise<void> => {
    await ReactTestRenderer.act(async () => {
      await listeners[listeners.length - 1].onEvent({ tag: 'other' })
    })
    await settle(700)
  }

  test('an older read answering after a newer one paints nothing', async () => {
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    let older: ((value: unknown) => void) | undefined
    sdk.getInfo.mockImplementationOnce(() => new Promise(resolve => (older = resolve)))
    await event()
    sdk.getInfo.mockResolvedValue(info(2_222))
    await event()
    // The request waits for the read out, and the bound lets it past one that never answers.
    await settle(SYNC_WAIT_MS)
    expect(screenText(tree)).toContain(sats(2_222))

    await ReactTestRenderer.act(async () => {
      older?.(info(1_111))
    })
    await settle()

    expect(screenText(tree)).toContain(sats(2_222))
    expect(screenText(tree)).not.toContain(sats(1_111))
  })

  test('an older load failing while a newer one is out shows no error', async () => {
    let older: ((cause: Error) => void) | undefined
    let newer: ((value: unknown) => void) | undefined
    const tree = await render(<HomeScreen />)
    // The watcher reads for a failed sync before it takes the Synced, ahead of the screen's two loads.
    sdk.getInfo.mockResolvedValueOnce(info(0))
    sdk.getInfo.mockImplementationOnce(() => new Promise((_, reject) => (older = reject)))
    sdk.getInfo.mockImplementationOnce(() => new Promise(resolve => (newer = resolve)))
    await emitSynced(connects[0].watcher)
    await ReactTestRenderer.act(async () => {
      await listeners[listeners.length - 1].onEvent({ tag: 'other' })
    })
    await settle(SYNC_WAIT_MS)
    expect(older).toBeDefined()
    expect(newer).toBeDefined()

    await ReactTestRenderer.act(async () => {
      older?.(new Error('read failed'))
    })
    await settle()
    expect(screenText(tree)).not.toContain(i18n.t('home.connectionError'))

    await ReactTestRenderer.act(async () => {
      newer?.(info(2_222))
    })
    await settle()
    expect(screenText(tree)).toContain(sats(2_222))
  })
})

// The sync answers with a resolved promise whether or not it reached anyone, and only a Synced proves
// it did, so the screen is held to the event.
describe('pulling Home to refresh', () => {

  // A synced screen, with the database moved on, so a read it should not have made would show.
  async function settled(figure = info(3_062)): Promise<ReactTestRenderer.ReactTestRenderer> {
    sdk.getInfo.mockResolvedValue(figure)
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    sdk.getInfo.mockResolvedValue(info(9_999))
    return tree
  }

  test('nothing on screen moves while the sync is out', async () => {
    const tree = await settled()
    sdk.syncWallet.mockReturnValue(new Promise(() => undefined))
    const before = screenText(tree)
    const reads = sdk.getInfo.mock.calls.length

    await pull(tree)
    await settle(SYNC_WAIT_MS - 1)

    expect(control(tree).props.refreshing).toBe(true)
    expect(screenText(tree)).toBe(before)
    expect(skeletons(tree)).toBe(0)
    expect(sdk.getInfo).toHaveBeenCalledTimes(reads)
  })

  test('a figure already marked stays exactly as it was while the sync is out', async () => {
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)
    sdk.syncWallet.mockReturnValue(new Promise(() => undefined))
    sdk.getInfo.mockResolvedValue(info(9_999))
    const before = screenText(tree)
    expect(before).toContain(MARK)

    await pull(tree)
    await settle(5_000)

    expect(screenText(tree)).toBe(before)
  })

  test('a sync that was heard brings the new figure and no mark, and the spinner closes', async () => {
    const tree = await settled()
    syncAnswers()

    await pull(tree)
    await settle(700)

    expect(screenText(tree)).toContain(sats(9_999))
    expect(screenText(tree)).not.toContain(MARK)
    expect(control(tree).props.refreshing).toBe(false)
  })

  test('a sync that was heard clears a mark that was already up', async () => {
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)
    expect(screenText(tree)).toContain(MARK)
    syncAnswers()

    await pull(tree)
    await settle(700)

    expect(screenText(tree)).not.toContain(MARK)
  })

  test.each([
    ['sats', () => info(3_062), TOTAL],
    ['portfolio', () => info(3_062, USDB_BASE), TOTAL],
  ])('Ok with no Synced marks a %s hero', async (_kind, figure, label) => {
    const tree = await settled(figure())

    await pull(tree)
    await settle()

    expect(screenText(tree)).toContain(MARK)
    expect(screenText(tree)).toContain(label)
    expect(skeletons(tree)).toBe(0)
  })

  test('Ok with no Synced marks a dollar hero', async () => {
    mockStable = true
    const tree = await settled(info(0, USDB_BASE))

    await pull(tree)
    await settle()

    expect(screenText(tree)).toContain(MARK)
  })

  test('a rejected sync marks the figure and shows no error', async () => {
    const tree = await settled()
    sdk.syncWallet.mockRejectedValue(new Error('network unreachable'))

    await pull(tree)
    await settle()

    expect(screenText(tree)).toContain(MARK)
    expect(screenText(tree)).toContain(sats(9_999))
    expect(screenText(tree)).not.toContain(i18n.t('home.connectionError'))
  })

  test('the mark goes up even when the read after the sync never answers', async () => {
    const tree = await settled()
    sdk.getInfo.mockReturnValue(new Promise(() => undefined))

    await pull(tree)
    await settle()

    expect(screenText(tree)).toContain(MARK)
    expect(screenText(tree)).toContain(sats(3_062))
  })

  test('a Synced after a failed pull takes the mark away', async () => {
    const tree = await settled()
    await pull(tree)
    await settle()
    expect(screenText(tree)).toContain(MARK)

    await emitSynced(connects[0].watcher)

    expect(screenText(tree)).not.toContain(MARK)
  })

  test('offline, the rates are kept and the total stays a total, marked', async () => {
    const tree = await settled(info(3_062, USDB_BASE))
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    sdk.listFiatRates.mockRejectedValue(new Error('network unreachable'))
    sdk.syncWallet.mockRejectedValue(new Error('network unreachable'))
    const total = norm(formatFiat(satsToFiat(3_062, BRL) + 22.6755 * (BRL / USD), 'BRL'))

    await pull(tree)
    await settle()

    expect(screenText(tree)).toContain(total)
    expect(screenText(tree)).toContain(MARK)
  })

  test('the spinner closes at SYNC_WAIT_MS with the sync and the rates both silent', async () => {
    const tree = await settled()
    sdk.syncWallet.mockReturnValue(new Promise(() => undefined))
    sdk.listFiatRates.mockReturnValue(new Promise(() => undefined))

    await pull(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS - 1)
    })
    expect(control(tree).props.refreshing).toBe(true)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(1)
    })

    expect(control(tree).props.refreshing).toBe(false)
    await settle()
    expect(screenText(tree)).toContain(MARK)
  })

  test('a pull neither reconnects nor disconnects', async () => {
    const tree = await settled()
    const opened = binding.connect.mock.calls.length
    const closed = sdk.disconnect.mock.calls.length
    syncAnswers()

    await pull(tree)
    await settle(700)
    sdk.syncWallet.mockResolvedValue({})
    await pull(tree)
    await settle()

    expect(binding.connect).toHaveBeenCalledTimes(opened)
    expect(sdk.disconnect).toHaveBeenCalledTimes(closed)
    expect(sdk.syncWallet).toHaveBeenCalledTimes(2)
  })

  test('a switch while the sync is out lands nothing from the pull', async () => {
    const tree = await settled()
    let answer: ((value: object) => void) | undefined
    sdk.syncWallet.mockReturnValue(new Promise(resolve => (answer = resolve)))
    await pull(tree)

    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    const reads = sdk.getInfo.mock.calls.length
    await ReactTestRenderer.act(async () => {
      answer?.({})
    })
    await settle()

    expect(sdk.getInfo).toHaveBeenCalledTimes(reads)
    expect(screenText(tree)).not.toContain(sats(3_062))
    expect(screenText(tree)).not.toContain(MARK)
  })

  test('there is no pull on the skeleton', async () => {
    const tree = await render(<HomeScreen />)

    expect(control(tree)).toBeUndefined()
  })

  test('there is no pull while the assets are being edited', async () => {
    const tree = await settled()
    expect(control(tree)).toBeDefined()

    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AssetList).props.onEnterEdit()
    })

    expect(control(tree)).toBeUndefined()
  })

  test('on a failed connect the pull is Try again, and asks for no sync', async () => {
    binding.connect.mockRejectedValueOnce(new Error('connect failed'))
    const tree = await render(<HomeScreen />)
    expect(screenText(tree)).toContain(i18n.t('home.connectionError'))

    await pull(tree)
    await settle()

    expect(binding.connect).toHaveBeenCalledTimes(2)
    expect(sdk.syncWallet).not.toHaveBeenCalled()
    expect(screenText(tree)).not.toContain(i18n.t('home.connectionError'))
  })
})

describe('what a pull says when it ends', () => {
  const entered = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
    tree.root.findAllByType(Reenter).some(part => part.props.beat > 0)
  async function settled(figure = info(3_062)): Promise<ReactTestRenderer.ReactTestRenderer> {
    sdk.getInfo.mockResolvedValue(figure)
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    sdk.getInfo.mockResolvedValue(info(9_999))
    return tree
  }
  const leaving = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'cross-fade-leaving')

  test('a Synced heard re-enters the hero, the rows and the strip on one beat, in that order', async () => {
    const tree = await settled()
    syncAnswers()

    await pull(tree)
    await settle()

    const parts = tree.root.findAllByType(Reenter).map(part => part.props)
    expect(parts.map(part => part.order).sort()).toEqual([0, 1, 2])
    expect(new Set(parts.map(part => part.beat))).toEqual(new Set([1]))
  })

  test('a pull whose rates did not answer shows no answer, since the money figure is the last one', async () => {
    const tree = await settled()
    syncAnswers()
    sdk.listFiatRates.mockRejectedValue(new Error('network unreachable'))

    await pull(tree)
    await settle()

    expect(entered(tree)).toBe(false)
  })

  test("Ok with no Synced shows no answer, and the 'not updated' mark instead", async () => {
    const tree = await settled()
    sdk.syncWallet.mockResolvedValue({})

    await pull(tree)
    await settle(700)

    expect(entered(tree)).toBe(false)
    expect(screenText(tree)).toContain(MARK)
  })

  test('a failed sync shows no answer either', async () => {
    const tree = await settled()
    sdk.syncWallet.mockRejectedValue(new Error('network unreachable'))

    await pull(tree)
    await settle(700)

    expect(entered(tree)).toBe(false)
    expect(screenText(tree)).toContain(MARK)
  })

  test('a read on the clock that reports a failed sync marks the figure at once', async () => {
    const tree = await settled()
    expect(screenText(tree)).not.toContain(MARK)
    sdk.getInfo.mockResolvedValue({ ...info(3_062), lastSyncError: { message: 'unreachable' } })

    await settle(LIVE_READ_EVERY_MS)

    expect(screenText(tree)).toContain(MARK)
  })

  test('the figure did not read back, so nothing says it is updated', async () => {
    const tree = await settled()
    syncAnswers()
    sdk.getInfo.mockRejectedValue(new Error('storage busy'))

    await pull(tree)
    await settle(700)

    expect(entered(tree)).toBe(false)
  })

  // Rates that answer `ms` after the read asks, as a slow network does.
  const ratesTake = (ms: number): void => {
    sdk.listFiatRates.mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(() => resolve({ rates: [{ coin: 'BRL', value: BRL }] }), ms),
        ),
    )
  }
  const fading = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
    tree.root.findByType(AssetList).props.fading

  test('a pull follows the load that replaced it, and the answer comes with its figures', async () => {
    const tree = await settled()
    ratesTake(700)
    syncAnswers()

    await pull(tree)
    await settle(100)
    await refocus(tree)
    await settle(699)
    expect(screenText(tree)).toContain(sats(3_062))
    expect(screenText(tree)).not.toContain(sats(9_999))
    expect(entered(tree)).toBe(false)
    expect(control(tree).props.refreshing).toBe(true)

    await settle(1)
    expect(screenText(tree)).toContain(sats(9_999))
    expect(entered(tree)).toBe(true)
    expect(control(tree).props.refreshing).toBe(false)
  })

  test('a pull follows every load that replaces the last, up to the one that lands', async () => {
    const tree = await settled()
    ratesTake(1_500)
    syncAnswers()

    await pull(tree)
    await settle(100)
    await refocus(tree)
    await settle(100)
    await refocus(tree)
    await settle(1_499)
    expect(entered(tree)).toBe(false)
    expect(screenText(tree)).not.toContain(sats(9_999))

    await settle(1)
    expect(entered(tree)).toBe(true)
    expect(screenText(tree)).toContain(sats(9_999))
  })

  test('the load that replaced the pull\'s fails: no answer over a figure that never changed', async () => {
    const tree = await settled()
    ratesTake(700)
    syncAnswers()
    pullReadsAnswer()
    sdk.getInfo.mockResolvedValueOnce(info(9_999))
    sdk.getInfo.mockRejectedValue(new Error('storage busy'))

    await pull(tree)
    await settle(800)
    expect(entered(tree)).toBe(false)

    await settle(1_000)
    expect(screenText(tree)).toContain(sats(3_062))
    expect(entered(tree)).toBe(false)
    expect(fading(tree)).toBe(false)
  })

  test('the load before the pull\'s fails while the pull\'s is out, and the pull\'s answers', async () => {
    const tree = await settled()
    let refuse: ((cause: Error) => void) | undefined
    ratesTake(700)
    pullReadsAnswer()
    sdk.getInfo.mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
    syncAnswers()

    await pull(tree)
    await settle(650)
    await ReactTestRenderer.act(async () => {
      refuse?.(new Error('storage busy'))
    })
    await settle(49)
    expect(entered(tree)).toBe(false)

    await settle(1)
    expect(screenText(tree)).toContain(sats(9_999))
    expect(entered(tree)).toBe(true)
    expect(leaving(tree)).toHaveLength(1)
  })

  test('a load that never answers ends the pull at the bound, with no answer', async () => {
    const tree = await settled()
    ratesTake(700)
    syncAnswers()
    pullReadsAnswer()
    sdk.getInfo.mockResolvedValueOnce(info(9_999))
    sdk.getInfo.mockReturnValue(new Promise(() => undefined))

    await pull(tree)
    await settle(SYNC_WAIT_MS - 1)
    expect(entered(tree)).toBe(false)
    expect(fading(tree)).toBe(true)

    await settle(1 + motion.base)
    expect(entered(tree)).toBe(false)
    expect(fading(tree)).toBe(false)
  })

  // The Synced's own read goes out first and the pull's replaces it. Past the rates' own wait a load
  // goes without them, so the balance still lands within it.
  test.each([
    { rates: 0, landing: 0 },
    { rates: 300, landing: 300 },
    { rates: 599, landing: 599 },
    { rates: 700, landing: 700 },
    { rates: 1_500, landing: 1_500 },
    { rates: 2_900, landing: 2_900 },
    { rates: 5_000, landing: 3_000 },
  ])('a figure that changed crosses over with rates at $rates ms', async ({ rates, landing }) => {
    const tree = await settled()
    ratesTake(rates)
    syncAnswers()

    await pull(tree)
    await settle(landing)

    expect(leaving(tree)).toHaveLength(1)
    expect(screenText(tree)).toContain(sats(9_999))
    expect(screenText(tree)).toContain(sats(3_062))
    expect(entered(tree)).toBe(true)
    expect(fading(tree)).toBe(true)
  })

  test('with slow rates nothing moves before a slow sync, and all of it lands after', async () => {
    const tree = await settled()
    ratesTake(700)
    sdk.syncWallet.mockImplementation(
      () =>
        new Promise(resolve =>
          setTimeout(() => {
            deliverSynced().then(() => resolve({}))
          }, 5_000),
        ),
    )
    const before = screenText(tree)
    const reads = sdk.getInfo.mock.calls.length

    await pull(tree)
    await settle(4_999)
    expect(screenText(tree)).toBe(before)
    expect(sdk.getInfo).toHaveBeenCalledTimes(reads)
    expect(fading(tree)).toBe(false)
    expect(leaving(tree)).toHaveLength(0)

    await settle(1)
    expect(fading(tree)).toBe(true)
    await settle(699)
    expect(screenText(tree)).toBe(before)

    await settle(1)
    expect(screenText(tree)).toContain(sats(9_999))
    expect(entered(tree)).toBe(true)
    expect(leaving(tree)).toHaveLength(1)
  })

  test('nothing is said while the sync is out, and nothing moves', async () => {
    const tree = await settled()
    sdk.syncWallet.mockReturnValue(new Promise(() => undefined))
    const before = screenText(tree)

    await pull(tree)
    await settle()
    expect(screenText(tree)).toBe(before)

    await settle(SYNC_WAIT_MS - 1)
    expect(screenText(tree)).toBe(before)
    expect(leaving(tree)).toHaveLength(0)
    expect(tree.root.findByType(AssetList).props.fading).toBe(false)
  })

  test('a figure that changed crosses over to the new value', async () => {
    const tree = await settled()
    syncAnswers()

    await pull(tree)
    await settle()

    expect(leaving(tree)).toHaveLength(1)
    expect(screenText(tree)).toContain(sats(9_999))
    expect(screenText(tree)).toContain(sats(3_062))
    expect(tree.root.findByType(AssetList).props.fading).toBe(true)

    await settle(motion.base)
    expect(leaving(tree)).toHaveLength(0)
    expect(screenText(tree)).not.toContain(sats(3_062))
    expect(tree.root.findByType(AssetList).props.fading).toBe(false)
  })

  test('a figure that did not change does not fade', async () => {
    const tree = await settled()
    sdk.getInfo.mockResolvedValue(info(3_062))
    syncAnswers()

    await pull(tree)
    await settle()

    expect(leaving(tree)).toHaveLength(0)
  })

  test('each pull that landed answers once', async () => {
    const tree = await settled()
    syncAnswers()
    await pull(tree)
    await settle()
    await pull(tree)
    await settle()

    expect(tree.root.findAllByType(Reenter)[0].props.beat).toBe(2)
  })

  test('a finger on the page holds the page still, and the figures still land', async () => {
    const tree = await settled()
    syncAnswers()
    const page = tree.root.findAll(node => typeof node.props.onTouchCancel === 'function')[0]
    ReactTestRenderer.act(() => page.props.onTouchStart())

    await pull(tree)
    await settle()

    expect(entered(tree)).toBe(false)
    expect(screenText(tree)).toContain('R$41.14')

    ReactTestRenderer.act(() => page.props.onTouchEnd({ nativeEvent: { touches: [] } }))
    await pull(tree)
    await settle()
    expect(entered(tree)).toBe(true)
  })

  test('a wallet switch during the read lands no answer for the new wallet', async () => {
    const tree = await settled()
    let answer: ((value: unknown) => void) | undefined
    sdk.getInfo.mockImplementation(() => new Promise(resolve => (answer = resolve)))
    syncAnswers()
    await pull(tree)
    await settle()

    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    await ReactTestRenderer.act(async () => {
      answer?.(info(9_999))
    })
    await settle()

    expect(entered(tree)).toBe(false)
  })
})

describe('Home before the first sync', () => {
  test('waits on the skeleton, then shows the synced figure and never the stored one', async () => {
    const tree = await render(<HomeScreen />)

    expect(skeletons(tree)).toBeGreaterThan(0)
    expect(screenText(tree)).not.toContain(sats(10_435))

    await settle(5_000)
    expect(screenText(tree)).not.toContain(sats(10_435))

    sdk.getInfo.mockResolvedValue(info(3_062))
    await emitSynced(connects[0].watcher)

    expect(screenText(tree)).toContain(sats(3_062))
    expect(screenText(tree)).not.toContain(sats(10_435))
    expect(screenText(tree)).not.toContain(MARK)
  })

  test('after the wait shows the stored figure marked, and the sync takes the mark away', async () => {
    const tree = await render(<HomeScreen />)

    await settle(SYNC_WAIT_MS + 700)
    expect(screenText(tree)).toContain(sats(10_435))
    expect(screenText(tree)).toContain(MARK)

    sdk.getInfo.mockResolvedValue(info(3_062))
    await emitSynced(connects[0].watcher)

    expect(screenText(tree)).toContain(sats(3_062))
    expect(screenText(tree)).not.toContain(MARK)
  })

  test('an event that is not Synced does not count as the sync', async () => {
    const tree = await render(<HomeScreen />)

    await ReactTestRenderer.act(async () => {
      // Shaped as the SDK sends it: a payment event always carries its payment.
      await connects[0].watcher?.onEvent({
        tag: SdkEvent_Tags.PaymentSucceeded,
        inner: {
          payment: {
            id: 'received-1',
            paymentType: PaymentType.Receive,
            status: PaymentStatus.Completed,
            amount: 1000n,
            fees: 0n,
            timestamp: 1n,
            method: 1,
          },
        },
      })
    })
    await settle(700)

    expect(screenText(tree)).not.toContain(sats(10_435))
    await settle(SYNC_WAIT_MS)
    expect(screenText(tree)).toContain(MARK)
  })
})

describe('Home offline after a restart', () => {
  test('ends on the stored figure marked, never a skeleton for good and never unmarked', async () => {
    sdk.listFiatRates.mockRejectedValue(new Error('offline'))
    const tree = await render(<HomeScreen />)

    await settle(SYNC_WAIT_MS + 700)
    expect(skeletons(tree)).toBe(0)
    expect(screenText(tree)).toContain(sats(10_435))
    expect(screenText(tree)).toContain(MARK)

    // No sync ever comes, and a refocus re-reads the same connection.
    await settle(120_000)
    mockFocused = false
    await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
    mockFocused = true
    await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
    await settle()

    expect(screenText(tree)).toContain(sats(10_435))
    expect(screenText(tree)).toContain(MARK)
  })
})

describe('a wallet switch', () => {
  test("an older connection's sync never marks the new wallet, whose figure waits for its own", async () => {
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(sats(3_062))

    // The picker switches first and Home reconnects on focus.
    jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    expect(screenText(tree)).not.toContain(sats(3_062))

    sdk.getInfo.mockResolvedValue(info(17_920))
    mockFocused = false
    await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
    mockFocused = true
    await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
    await settle()
    expect(connects).toHaveLength(2)
    expect(screenText(tree)).not.toContain(sats(3_062))
    expect(screenText(tree)).not.toContain(sats(17_920))

    // Every listener of wallet A hears a late Synced; none of them speaks for wallet B.
    for (const listener of listeners.slice(0, connects[1].from)) {
      await ReactTestRenderer.act(async () => {
        await listener.onEvent({ tag: SdkEvent_Tags.Synced })
      })
    }
    await settle(700)
    expect(screenText(tree)).not.toContain(sats(17_920))
    expect((await sparkGetWalletInfo()).sync).toBe('waiting')

    await emitSynced(connects[1].watcher)
    expect(screenText(tree)).toContain(sats(17_920))
    expect(screenText(tree)).not.toContain(MARK)
  })
})

describe('a switch away from a wallet that never synced', () => {
  test('its late first sync does not mark the wallet switched to', async () => {
    const tree = await render(<HomeScreen />)

    jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    sdk.getInfo.mockResolvedValue(info(17_920))
    mockFocused = false
    await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
    mockFocused = true
    await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
    await settle()
    expect(connects).toHaveLength(2)

    await emitSynced(connects[0].watcher)

    expect((await sparkGetWalletInfo()).sync).toBe('waiting')
    expect(screenText(tree)).not.toContain(sats(17_920))
  })
})

async function refocus(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocused = false
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  mockFocused = true
  await ReactTestRenderer.act(async () => tree.update(<HomeScreen />))
  await settle()
}

// The registry the real wallet.ts reads and writes, so a move of the active pointer reaches the
// connect that follows it.
function twoWallets(): void {
  jest.mocked(loadRegistry).mockResolvedValue({
    wallets: [
      { id: 'wallet-a', fingerprint: 'fa' },
      { id: 'wallet-b', fingerprint: 'fb' },
    ],
    active: 'wallet-a',
  })
  jest.mocked(setActiveWallet).mockImplementation(async id => {
    jest.mocked(getActiveWalletId).mockResolvedValue(id)
  })
}

describe('removing or adding the active wallet', () => {
  test("removing drops the removed wallet's figure at once, and it never returns while the next one connects or fails", async () => {
    twoWallets()
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(sats(3_062))

    await ReactTestRenderer.act(async () => {
      await removeActiveWallet()
    })
    expect(deleteSeedFor).toHaveBeenCalledWith('wallet-a')
    expect(screenText(tree)).not.toContain(sats(3_062))

    let fail!: (error: Error) => void
    binding.connect.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    await refocus(tree)
    expect(screenText(tree)).not.toContain(sats(3_062))

    await ReactTestRenderer.act(async () => fail(new Error('offline')))
    await settle(30_000)
    expect(screenText(tree)).not.toContain(sats(3_062))
    expect(screenText(tree)).toContain('Could not connect to the wallet.')
  })

  test("adding a wallet drops the previous wallet's figure before the new one connects", async () => {
    twoWallets()
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(sats(3_062))

    await ReactTestRenderer.act(async () => {
      await addAndActivateWallet(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      )
    })
    expect(setActiveWallet).toHaveBeenCalledWith('wallet-new')
    expect(screenText(tree)).not.toContain(sats(3_062))

    binding.connect.mockImplementationOnce(() => new Promise(() => undefined))
    await refocus(tree)
    expect(screenText(tree)).not.toContain(sats(3_062))
  })
})

describe('the hero with pegged tokens', () => {
  test('sats plus USDB lead with the total, and the sats line names bitcoin', async () => {
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const satsFiat = satsToFiat(3_062, BRL)
    const total = satsFiat + 22.6755 * (BRL / USD)
    const text = screenText(tree)
    expect(text).toContain(TOTAL)
    expect(text).toContain(norm(formatFiat(total, 'BRL')))
    expect(text).toContain(norm(`${formatSats(3_062)} sats in bitcoin`))
    // The bitcoin-only value is never drawn beside the total, and the total never beside bare sats.
    expect(text).not.toContain(norm(formatFiat(satsFiat, 'BRL')))
  })

  test('sats only keep the sats hero over their own value', async () => {
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expect(text).toContain(TOTAL)
    expect(text).toContain(sats(3_062))
    expect(text).toContain(norm(formatFiat(satsToFiat(3_062, BRL), 'BRL')))
    expect(text).not.toContain('in bitcoin')
  })

  test('USDB only leads with its value, and the sats line says zero in bitcoin', async () => {
    sdk.getInfo.mockResolvedValue(info(0, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expect(text).toContain(TOTAL)
    expect(text).toContain(norm(formatFiat(22.6755 * (BRL / USD), 'BRL')))
    expect(text).toContain(norm(`${formatSats(0)} sats in bitcoin`))
  })

  test('dollar mode with its rates leads with the dollar total', async () => {
    mockStable = true
    sdk.getInfo.mockResolvedValue(info(0, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expect(text).toContain(TOTAL)
    expect(text).toContain(norm(formatFiat(22.6755, 'USD')))
    expect(text).toContain(DOLLAR_LINE)
  })
})

// The label claims the whole wallet, so a holding no rate can value turns the hero back into the
// bitcoin balance, its fiat line into that bitcoin's own value, and leaves the tokens to the list.
// AssetList is stubbed under Jest, so a token's row is read from what Home hands it.
function rowAmount(tree: ReactTestRenderer.ReactTestRenderer, assetId: string): number {
  const rows = tree.root.findByType(AssetList).props.assets as { assetId: string; amount: string }[]
  return Number(rows.find(row => row.assetId === assetId)?.amount)
}

describe("a holding the rates cannot value", () => {
  function expectBitcoinHero(text: string, satsShown: number): void {
    expect(text).toContain(BITCOIN)
    expect(text).not.toContain(TOTAL)
    expect(text).toContain(sats(satsShown))
    expect(text).not.toContain('in bitcoin')
  }

  test('offline after a restart, 0 sats and USDB read as 0 sats of bitcoin, marked, never as the total', async () => {
    sdk.listFiatRates.mockRejectedValue(new Error('offline'))
    sdk.getInfo.mockResolvedValue(info(0, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)

    const text = screenText(tree)
    expectBitcoinHero(text, 0)
    expect(text).toContain(MARK)
    expect(text).not.toContain('R$')
    expect(rowAmount(tree, USDB.identifier)).toBe(22.68)
  })

  test('a feed without USD keeps the sats hero over their own value', async () => {
    sdk.listFiatRates.mockResolvedValue({ rates: [{ coin: 'BRL', value: BRL }] })
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expectBitcoinHero(text, 3_062)
    expect(text).toContain(norm(formatFiat(satsToFiat(3_062, BRL), 'BRL')))
    expect(text).not.toContain(MARK)
  })

  test('a token added by its identifier, with no peg, keeps the sats hero', async () => {
    sdk.getInfo.mockResolvedValue(info(3_062, undefined, 500_000_000n))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expectBitcoinHero(text, 3_062)
    expect(text).toContain(norm(formatFiat(satsToFiat(3_062, BRL), 'BRL')))
    expect(rowAmount(tree, OTHER_ID)).toBe(5)
  })

  test('a priced USDB beside an unpriced token never makes a total', async () => {
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE, 500_000_000n))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expectBitcoinHero(text, 3_062)
    expect(text).not.toContain(norm(formatFiat(satsToFiat(3_062, BRL) + 22.6755 * (BRL / USD), 'BRL')))
  })

  test('dollar mode without its rates shows the bitcoin balance and keeps the dollar line', async () => {
    mockStable = true
    sdk.listFiatRates.mockRejectedValue(new Error('offline'))
    sdk.getInfo.mockResolvedValue(info(0, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)

    const text = screenText(tree)
    expectBitcoinHero(text, 0)
    expect(text).toContain(MARK)
    expect(text).not.toMatch(/(?<!R)\$\d/)
    expect(text).toContain(DOLLAR_LINE)
  })

  test('dollar mode with a feed without USD never shows a dollar figure it cannot back', async () => {
    mockStable = true
    sdk.listFiatRates.mockResolvedValue({ rates: [{ coin: 'BRL', value: BRL }] })
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)

    const text = screenText(tree)
    expect(text).not.toMatch(/(?<!R)\$\d/)
    expect(text).toContain(TOTAL)
    expect(text).toContain(sats(3_062))
    expect(text).toContain(norm(formatFiat(satsToFiat(3_062, BRL), 'BRL')))
    expect(text).toContain(norm(`${formatSats(3_062)} sats waiting to turn into dollars`))
  })

  test('an empty wallet offline is still its whole total, in sats', async () => {
    sdk.listFiatRates.mockRejectedValue(new Error('offline'))
    sdk.getInfo.mockResolvedValue(info(0))
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)

    const text = screenText(tree)
    expect(text).toContain(TOTAL)
    expect(text).toContain(sats(0))
    expect(text).toContain(MARK)
  })
})

// Each hero carries the mark on its own, so a pre-sync figure is never shown plain in any of them.
describe('the not-updated mark on every hero', () => {
  test('the portfolio hero, past the wait, is marked until the sync', async () => {
    sdk.getInfo.mockResolvedValue(info(3_062, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)

    const total = satsToFiat(3_062, BRL) + 22.6755 * (BRL / USD)
    expect(screenText(tree)).toContain(norm(formatFiat(total, 'BRL')))
    expect(screenText(tree)).toContain(MARK)

    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(norm(formatFiat(total, 'BRL')))
    expect(screenText(tree)).not.toContain(MARK)
  })

  test('the dollar hero, past the wait, is marked until the sync', async () => {
    mockStable = true
    sdk.getInfo.mockResolvedValue(info(0, USDB_BASE))
    const tree = await render(<HomeScreen />)
    await settle(SYNC_WAIT_MS + 700)

    expect(screenText(tree)).toContain(norm(formatFiat(22.6755, 'USD')))
    expect(screenText(tree)).toContain(MARK)

    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(norm(formatFiat(22.6755, 'USD')))
    expect(screenText(tree)).not.toContain(MARK)
  })
})

describe('loads that land after the wallet moved', () => {
  test('a refresh the previous wallet started lands nowhere once the switch is heard', async () => {
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(sats(3_062))

    let answer!: (value: unknown) => void
    sdk.getInfo.mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await refocus(tree)

    jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    await ReactTestRenderer.act(async () => answer(info(5_000)))
    await settle()

    expect(screenText(tree)).not.toContain(sats(5_000))
    expect(screenText(tree)).not.toContain(sats(3_062))
    expect(skeletons(tree)).toBeGreaterThan(0)
  })

  test("a load that reaches another wallet's connection drops the figure, even unannounced", async () => {
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(sats(3_062))

    // The pointer moves with nothing announced, as the registry's own fallback can move it.
    jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
    sdk.getInfo.mockResolvedValue(info(17_920))
    await refocus(tree)

    expect(connects).toHaveLength(2)
    expect(screenText(tree)).not.toContain(sats(3_062))
    expect(screenText(tree)).not.toContain(sats(17_920))
    expect(skeletons(tree)).toBeGreaterThan(0)
  })
})

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const buttons = tree.root.findAllByType(GradientButton).filter(b => b.props.label === label)
  const touches = tree.root.findAllByType(Touch).filter(b => b.props.label === label)
  const target = buttons[0] ?? touches[0]
  if (!target) {
    throw new Error(`no ${label} on screen`)
  }
  await ReactTestRenderer.act(async () => {
    await target.props.onPress()
  })
}

// A connect that answers only when the test says, keeping the bookkeeping the default one keeps.
function heldConnect(): () => Promise<void> {
  let finish!: () => void
  binding.connect.mockImplementationOnce(
    () =>
      new Promise(resolve => {
        finish = () => {
          connects.push({ watcher: null, from: listeners.length })
          resolve(sdk)
        }
      }),
  )
  return async () => {
    await ReactTestRenderer.act(async () => finish())
    await settle()
  }
}

describe('the actions while the figures wait', () => {
  test('Send, Receive and Scan are there and open at once while the balance is a skeleton', async () => {
    const tree = await render(<HomeScreen />)
    expect(skeletons(tree)).toBeGreaterThan(0)
    expect(screenText(tree)).not.toContain(sats(10_435))

    await press(tree, 'Send')
    await press(tree, 'Receive')
    await press(tree, 'Scan')
    expect(mockNavigation.navigate.mock.calls).toEqual([['Send'], ['Receive'], ['Scan']])
  })

  test('a press before the connect lands opens once it does, and never before', async () => {
    const release = heldConnect()
    const tree = await render(<HomeScreen />)
    expect(connects).toHaveLength(0)

    await press(tree, 'Receive')
    expect(mockNavigation.navigate).not.toHaveBeenCalled()

    await release()
    expect(mockNavigation.navigate.mock.calls).toEqual([['Receive']])
  })

  test("after a switch a press waits for the new wallet's connection", async () => {
    const tree = await render(<HomeScreen />)

    jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    await press(tree, 'Send')
    expect(mockNavigation.navigate).not.toHaveBeenCalled()

    const release = heldConnect()
    await refocus(tree)
    expect(mockNavigation.navigate).not.toHaveBeenCalled()

    await release()
    expect(connects).toHaveLength(2)
    expect(mockNavigation.navigate.mock.calls).toEqual([['Send']])
  })

  // A press made for the new wallet must open on that wallet's connection. The previous wallet's
  // connect landing late would otherwise open Send on the old SDK session under the new wallet's name.
  test("the previous wallet's late connect never releases a press made after the switch", async () => {
    const releaseA = heldConnect()
    const tree = await render(<HomeScreen />)

    jest.mocked(getActiveWalletId).mockResolvedValue('wallet-b')
    await ReactTestRenderer.act(async () => {
      await switchWalletWithoutReconnecting('wallet-b')
    })
    await press(tree, 'Send')
    await releaseA()
    expect(mockNavigation.navigate).not.toHaveBeenCalled()

    await refocus(tree)
    expect(mockNavigation.navigate.mock.calls).toEqual([['Send']])
  })

  test('a connect that fails drops the held press, so a retry later opens nothing on its own', async () => {
    let fail!: (error: Error) => void
    binding.connect.mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    )
    const tree = await render(<HomeScreen />)
    await press(tree, 'Send')
    await ReactTestRenderer.act(async () => fail(new Error('offline')))
    await settle()
    expect(mockNavigation.navigate).not.toHaveBeenCalled()
    expect(screenText(tree)).toContain('Could not connect to the wallet.')

    await press(tree, 'Try again')
    await settle()
    expect(connects).toHaveLength(1)
    expect(mockNavigation.navigate).not.toHaveBeenCalled()
  })

  test('a held press is dropped when Home is no longer on screen as the connect lands', async () => {
    const release = heldConnect()
    const tree = await render(<HomeScreen />)
    await press(tree, 'Receive')
    mockNavigation.isFocused.mockReturnValue(false)

    await release()
    expect(mockNavigation.navigate).not.toHaveBeenCalled()
  })
})

describe('a navigation object that changes identity', () => {
  test('never turns the focus load into a loop', async () => {
    mockFreshNavigation = true
    sdk.getInfo.mockResolvedValue(info(3_062))
    const tree = await render(<HomeScreen />)
    await emitSynced(connects[0].watcher)
    await settle(2_000)

    expect(screenText(tree)).toContain(sats(3_062))
    // One on focus, the watcher's, and two for the sync, which reaches Home twice; a loop reads on every
    // render.
    expect(sdk.getInfo.mock.calls.length).toBeLessThanOrEqual(4)
  })
})

describe('the asset screen before the first sync', () => {
  test('waits on the skeleton, marks the stored figure after the wait, and the sync clears it', async () => {
    const tree = await render(<AssetDetailScreen />)

    expect(skeletons(tree)).toBeGreaterThan(0)
    expect(screenText(tree)).not.toContain(formatSats(10_435))

    await settle(SYNC_WAIT_MS + 700)
    expect(screenText(tree)).toContain(norm(formatSats(10_435)))
    expect(screenText(tree)).toContain(MARK)

    sdk.getInfo.mockResolvedValue(info(3_062))
    await emitSynced(connects[0].watcher)
    expect(screenText(tree)).toContain(norm(formatSats(3_062)))
    expect(screenText(tree)).not.toContain(MARK)
  })
})

describe('the flag itself', () => {
  test('a read reports the connection it came from: waiting, then stale, then synced', async () => {
    await render(<HomeScreen />)
    expect((await sparkGetWalletInfo()).sync).toBe('waiting')
    await settle(SYNC_WAIT_MS)
    expect((await sparkGetWalletInfo()).sync).toBe('stale')
    await emitSynced(connects[0].watcher)
    expect((await sparkGetWalletInfo()).sync).toBe('synced')
  })

  test('the watcher is in place before the connection is published', async () => {
    await render(<HomeScreen />)
    expect(connects[0].watcher).not.toBeNull()
    expect(connects[0].watcher).toBe(listeners[connects[0].from])
  })
})

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Dimensions, I18nManager, Linking, Platform, ScrollView, StyleSheet, Text, TextInput } from 'react-native'
import { figuresHeldOut, figuresIn, hostChildren, textOf } from './support/figureFit'
import { markedInOpenPicker } from './support/pickerMark'
import i18n from '../src/i18n'
import Clipboard from '@react-native-clipboard/clipboard'
import { SendSpark } from '../src/screens/SendSpark'
import { GradientButton } from '../src/components/GradientButton'
import { Screen } from '../src/components/Screen'
import { AmountSheet } from '../src/components/AmountSheet'
import { AssetPickerSheet, type PickerItem } from '../src/components/AssetPickerSheet'
import { ChunkedAddress } from '../src/components/ChunkedAddress'
import { ReceivedOverlay } from '../src/components/ReceivedOverlay'
import { Skeleton } from '../src/components/Skeleton'
import { SendBalance } from '../src/components/SendBalance'
import { DEPIX, USDB } from '../src/wallet/tokens'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'
import {
  sparkInspectDestination,
  sparkConfirmSend,
  sparkPrepareSend,
  sparkDiscardSendQuote,
  sparkPrepareCrossChainSend,
  sparkParseLnurlPay,
  sparkPrepareLnurlPay,
  sparkConfirmLnurlPay,
  sparkConfirmSendHeld,
  sparkDropHeldSend,
  sparkRetryHeldSend,
  sparkSendTakesKey,
  sparkFollowSend,
  sparkSentRail,
  sparkGetWalletInfo,
  sparkGetFiatRates,
  sparkGetStableBalance,
  sparkListFiatCurrencies,
  type BalanceSync,
  type SparkCrossChainQuote,
  type SparkSendQuote,
  type SparkCrossChainRoute,
  type SparkWalletInfo,
} from '../src/wallet/spark'
import { setForegroundNoticeHandler } from '../src/wallet/pushRoute'
import { formatSats } from '../src/wallet/amount'
import { saveDisplayCurrency } from '../src/wallet/settings'
import { cancelNfcRead, nfcState, openNfcSettings, readNfcDestination, type NfcRead } from '../src/wallet/nfc'
import { NfcReadSheet } from '../src/components/NfcReadSheet'
import { Sheet } from '../src/components/Sheet'
import { Row } from '../src/components/Row'
import { Card } from '../src/components/Card'
import { FigureRow } from '../src/components/FigureRow'
import { Amount } from '../src/components/Amount'
import { Touch } from '../src/components/Touch'
import { SegmentedControl } from '../src/components/SegmentedControl'
import { AssetIcon } from '../src/components/AssetIcon'
import { receiveStyles } from '../src/components/receiveStyles'
import { colors, font } from '../src/theme'
import RNFS from 'react-native-fs'
import { getCurrencies } from 'react-native-localize'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { SpendHeldByExit } from '../src/wallet/errors'
import { planOf } from './support/exitFixtures'

// The stock mock's region answer, made settable so a test can place the device outside the US.
const STOCK_DEVICE_CURRENCIES = ['USD', 'EUR']
jest.mock('react-native-localize', () => ({
  ...jest.requireActual('react-native-localize/mock'),
  // src/i18n reads it once when it loads, before any beforeEach runs, as the app does at boot.
  getCurrencies: jest.fn(() => ['USD', 'EUR']),
}))

let mockDollarMode = false
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => mockDollarMode,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

// The screen's first-sync listeners, called by a test to stand for the connection's first Synced.
let mockRouteParams: { destination?: string; picked?: number } = {}
const mockSparkRoute = { on: false }
jest.mock('../src/wallet/sendAll', () => ({
  ...jest.requireActual('../src/wallet/sendAll'),
  get PREFER_SPARK_ROUTE() {
    return mockSparkRoute.on
  },
}))

const mockSyncState = { current: 'synced' }
// The wallet the SDK signs with, which an exit under way holds.
const mockConnected: { id: string | null } = { id: 'primary' }
const mockSynced = new Set<() => void>()
const mockNavigate = jest.fn()
jest.mock('../src/wallet/spark', () => ({
  onSparkConnected: () => () => undefined,
  onSparkSynced: (cb: () => void) => {
    mockSynced.add(cb)
    return () => mockSynced.delete(cb)
  },
  sparkSyncWaitLeftMs: () => 0,
  sparkSyncState: () => mockSyncState.current,
  sparkConnectedWalletId: () => mockConnected.id,
  sparkClassify: jest.fn(async () => 'bolt11'),
  sparkInspectDestination: jest.fn(),
  sparkPrepareSend: jest.fn(),
  sparkPrepareCrossChainSend: jest.fn(),
  sparkDiscardSendQuote: jest.fn(),
  sparkConfirmSend: jest.fn(),
  // A send takes no key unless a test says so, which is what the token, conversion and cross-chain sends answer.
  sparkSendTakesKey: jest.fn(() => false),
  sparkConfirmSendHeld: jest.fn(),
  sparkRetryHeldSend: jest.fn(),
  sparkDropHeldSend: jest.fn(),
  sparkParseLnurlPay: jest.fn(),
  sparkPrepareLnurlPay: jest.fn(),
  sparkConfirmLnurlPay: jest.fn(),
  sparkFollowSend: jest.fn(),
  // The record names no rail unless a test says so, which keeps the words without one.
  sparkSentRail: jest.fn(() => undefined),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 0, tokens: [] })),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkGetStableBalance: jest.fn(async () => false),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/nfc', () => ({
  nfcState: jest.fn(async () => 'unsupported'),
  openNfcSettings: jest.fn(async () => true),
  readNfcDestination: jest.fn(),
  cancelNfcRead: jest.fn(),
}))
// The header button and the Android back key reach the screen through usePreventRemove. The swipe is
// switched off during review, so it never gets that far.
let mockPreventActive = false
let mockPreventCb: (() => void) | null = null
// Every focus effect the mounted screen holds, with its cleanup, so a test can blur and focus Send
// again as a return from another screen does.
const mockFocusEffects = new Map<() => unknown, unknown>()
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => unknown) =>
    require('react').useEffect(() => {
      mockFocusEffects.set(callback, callback())
      return () => {
        const cleanup = mockFocusEffects.get(callback)
        mockFocusEffects.delete(callback)
        if (typeof cleanup === 'function') {
          cleanup()
        }
      }
    }, [callback]),
  useNavigation: () => ({ goBack: jest.fn(), navigate: mockNavigate, replace: jest.fn(), setOptions: jest.fn() }),
  useRoute: () => ({ params: mockRouteParams }),
  usePreventRemove: (active: boolean, cb: () => void) => {
    mockPreventActive = active
    mockPreventCb = cb
  },
}))

const WITH_USDB = {
  sync: 'synced' as const,
  recoverableSat: 0,
  balanceSat: 100_000,
  tokens: [
    {
      identifier: USDB.identifier,
      ticker: USDB.ticker,
      name: USDB.name,
      decimals: USDB.decimals,
      balanceBaseUnits: 25_000_000,
    },
  ],
}

const SOLANA_ROUTE = {
  id: 'sol-addr|solana|USDC|orchestra',
  chain: 'solana',
  asset: 'USDC',
  decimals: 6,
  provider: 'orchestra' as const,
  accepts: { btc: true, usdb: false },
}
const BASE_ROUTE = {
  id: 'sol-addr|base|USDC|orchestra',
  chain: 'base',
  asset: 'USDC',
  decimals: 6,
  provider: 'orchestra' as const,
  accepts: { btc: true, usdb: false },
}

// The auto-prepare chain spans several microtasks, so flush a handful before asserting.
async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

// The picker sheet's FlatList schedules a timer that jest flags as a late log once the test ends.
let mounted: ReactTestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
  mockRouteParams = {}
})

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SendSpark />)
  })
  await settle()
  mounted = tree
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

async function pressBtn(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    btn.props.onPress()
  })
  await settle()
}

// A controlled TextInput paste does not fire onChangeText on New Arch, so pasting is the realistic entry.
async function pasteDestination(tree: ReactTestRenderer.ReactTestRenderer, text: string): Promise<void> {
  jest.mocked(Clipboard.getString).mockResolvedValue(text)
  await pressBtn(tree, 'Paste')
}

// The screen mounts two picker sheets (asset, route), so only the visible one is interactive.
async function pickFromSheet(tree: ReactTestRenderer.ReactTestRenderer, id: string): Promise<void> {
  const sheet = tree.root.findAllByType(AssetPickerSheet).find(node => node.props.visible)
  if (!sheet) {
    throw new Error('no picker sheet is open')
  }
  await ReactTestRenderer.act(async () => {
    sheet.props.onSelect(id)
  })
  await settle()
}

// A token's sheet hands on the base units typed, so its figure goes in through the keypad, as typed.
async function enterAmount(tree: ReactTestRenderer.ReactTestRenderer, value: number | string): Promise<void> {
  const sheet = tree.root.findByType(AmountSheet)
  if (sheet.props.tokenBounds) {
    for (const key of [...String(value), i18n.t('receive.confirmAmount')]) {
      const button = sheet
        .findAll(n => typeof n.props.onPress === 'function')
        .find(n => n.findAllByType(Text).some(txt => txt.props.children === key))
      if (!button) {
        throw new Error(`key not found: ${key}`)
      }
      await ReactTestRenderer.act(async () => {
        button.props.onPress()
      })
    }
    await settle()
    return
  }
  await ReactTestRenderer.act(async () => {
    sheet.props.onConfirm(value)
  })
  await settle()
}

beforeEach(() => {
  mockDollarMode = false
  jest.clearAllMocks()
  jest.mocked(getCurrencies).mockReturnValue(STOCK_DEVICE_CURRENCIES)
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 5 })
  jest.mocked(sparkConfirmSend).mockResolvedValue('complete')
  jest.mocked(sparkFollowSend).mockResolvedValue('pending')
  jest.mocked(sparkSentRail).mockReturnValue(undefined)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 0, tokens: [] })
  jest.mocked(Clipboard.getString).mockResolvedValue('')
})

describe('spending everything', () => {
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AmountSheet)
  const synced = (balanceSat: number, tokens: SparkWalletInfo['tokens'] = []): SparkWalletInfo => ({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat,
    tokens,
  })
  const toAddress = async (info: SparkWalletInfo) => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(info)
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    return tree
  }
  const tiers = {
    fast: { minerSat: 1000, sparkSat: 500, totalSat: 1500 },
    medium: { minerSat: 500, sparkSat: 500, totalSat: 1000 },
    slow: { minerSat: 100, sparkSat: 300, totalSat: 400 },
    estimate: false,
  }
  const useAll = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    await ReactTestRenderer.act(async () => sheet(tree).props.onUseAll())
    await settle()
  }

  test('with fees included the total is the amount, and a balance equal to it can confirm', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'all',
      amount: 50_000,
      fee: 100,
      feesIncluded: true,
      receives: 49_900,
    })
    const tree = await toAddress(synced(50_000))
    await useAll(tree)

    expect(sparkPrepareSend).toHaveBeenCalledWith('bc1qaddr', 50_000, undefined, true)
    expect(texts(tree).join(' ')).not.toContain('Not enough balance')
    expect(tree.root.findByType(GradientButton).props.disabled).toBe(false)
    const shown = texts(tree).join(' ')
    expect(shown).toContain(`${formatSats(49_900)} sats`)
    expect(shown).not.toContain(`${formatSats(50_100)} sats`)
  })

  test('on-chain the recipient line follows the speed, and the overlay says what arrived', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'all',
      amount: 50_000,
      fee: undefined,
      onchainFees: tiers,
      feesIncluded: true,
    })
    const tree = await toAddress(synced(50_000))
    await useAll(tree)

    expect(texts(tree).join(' ')).toContain(`${formatSats(49_000)} sats`)
    await pressBtn(tree, 'Economy')
    expect(texts(tree).join(' ')).toContain(`${formatSats(49_600)} sats`)

    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('all', 'slow')
    expect(tree.root.findByType(ReceivedOverlay).props.amount.value).toBe(49_600)
  })

  test('a fee that leaves nothing turns Confirm off', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'all',
      amount: 500,
      fee: 500,
      feesIncluded: true,
      receives: 0,
    })
    const tree = await toAddress(synced(500))
    await useAll(tree)

    expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
    expect(texts(tree).join(' ')).toContain(i18n.t('send.nothingArrives'))
  })

  test('a net under the address own limit turns Confirm off, since the SDK would refuse it at send', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'all',
      amount: 1_500,
      fee: undefined,
      feesIncluded: true,
      onchainFees: {
        fast: { totalSat: 1_100 },
        medium: { totalSat: 1_100 },
        slow: { totalSat: 1_100 },
      },
    } as never)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(synced(1_500))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    const tree = await render()
    await pasteDestination(tree, '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')
    await useAll(tree)

    expect(texts(tree).join(' ')).toContain(i18n.t('send.nothingArrives'))
  })

  test('two taps prepare once', async () => {
    let answer!: (quote: SparkSendQuote) => void
    jest.mocked(sparkPrepareSend).mockReturnValue(new Promise(resolve => (answer = resolve)))
    const tree = await toAddress(synced(50_000))
    const onUseAll = sheet(tree).props.onUseAll
    await ReactTestRenderer.act(async () => {
      onUseAll()
      onUseAll()
    })
    await settle()

    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => answer({ handle: 'h', amount: 50_000, fee: 0 }))
  })

  test.each([
    ['waiting', { sync: 'waiting', recoverableSat: 0, balanceSat: 50_000, tokens: [] } as SparkWalletInfo],
    ['stale', { sync: 'stale', recoverableSat: 0, balanceSat: 50_000, tokens: [] } as SparkWalletInfo],
  ])('a %s balance offers nothing and locks nothing', async (_name, info) => {
    const tree = await toAddress(info)
    expect(sheet(tree).props.available).toBeUndefined()
    expect(sheet(tree).props.onUseAll).toBeUndefined()
  })

  test('a zero balance has no chip', async () => {
    const tree = await toAddress(synced(0))
    expect(sheet(tree).props.available).toBe(0)
    expect(sheet(tree).props.onUseAll).toBeUndefined()
  })

  test('the dollar wallet offers nothing and locks nothing', async () => {
    mockDollarMode = true
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h', amount: 0, fee: 0 })
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(synced(50_000))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1amountless')

    expect(sheet(tree).props.visible).toBe(true)
    expect(sheet(tree).props.available).toBeUndefined()
    expect(sheet(tree).props.onUseAll).toBeUndefined()
  })

  test('the sheet reads the balance again when it opens, so money that just landed counts', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValueOnce(synced(1_000)).mockResolvedValue(synced(9_000))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')

    expect(sheet(tree).props.available).toBe(9_000)
  })

  test('while that read is out and after it fails, nothing is offered or locked', async () => {
    let answer!: (info: SparkWalletInfo) => void
    jest
      .mocked(sparkGetWalletInfo)
      .mockResolvedValueOnce(synced(50_000))
      .mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    expect(sheet(tree).props.visible).toBe(true)
    expect(sheet(tree).props.available).toBeUndefined()

    await ReactTestRenderer.act(async () => answer(synced(50_000)))
    await settle()
    expect(sheet(tree).props.available).toBe(50_000)
  })

  test('a read that fails on opening leaves nothing offered', async () => {
    jest
      .mocked(sparkGetWalletInfo)
      .mockResolvedValueOnce(synced(50_000))
      .mockRejectedValueOnce(new Error('offline'))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')

    expect(sheet(tree).props.available).toBeUndefined()
    expect(sheet(tree).props.onUseAll).toBeUndefined()
  })

  describe('a lightning address', () => {
    const toLnurl = async (balanceSat: number) => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(synced(balanceSat))
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
      jest.mocked(sparkParseLnurlPay).mockResolvedValue({
        handle: 'lnurl_1',
        minSat: 1000,
        maxSat: 100_000,
        commentAllowed: 0,
        payee: 'alice@example.com',
      })
      const tree = await render()
      await pasteDestination(tree, 'alice@example.com')
      return tree
    }

    test('offers the chip inside its range and pays through the LNURL flow', async () => {
      jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'p', amount: 50_000, fee: 10, feesIncluded: true, receives: 49_990 })
      const tree = await toLnurl(50_000)
      await ReactTestRenderer.act(async () => sheet(tree).props.onUseAll('hi'))
      await settle()

      expect(sparkPrepareLnurlPay).toHaveBeenCalledWith('lnurl_1', 50_000, 'hi', true)
    })

    test.each([
      ['above the maximum', 500_000],
      ['below the minimum', 500],
    ])('offers no chip with a balance %s, since cutting it and calling it all is false', async (_name, balance) => {
      const tree = await toLnurl(balance)
      expect(sheet(tree).props.onUseAll).toBeUndefined()
    })

    test('a fee that rose between the two queries says so and offers Try again', async () => {
      jest.mocked(sparkPrepareLnurlPay).mockRejectedValueOnce(new Error('Fee increased between queries. Please retry.'))
      const tree = await toLnurl(50_000)
      await ReactTestRenderer.act(async () => sheet(tree).props.onUseAll())
      await settle()
      expect(texts(tree).join(' ')).toContain(i18n.t('errors.feeIncreased'))

      jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'p', amount: 50_000, fee: 10, feesIncluded: true, receives: 49_990 })
      await pressBtn(tree, i18n.t('common.retry'))
      expect(sparkPrepareLnurlPay).toHaveBeenLastCalledWith('lnurl_1', 50_000, undefined, true)
      expect(tree.root.findByType(GradientButton).props.disabled).toBe(false)
    })
  })

  test('Try again belongs to the destination it failed on, so clearing the field takes it away', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(synced(50_000))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockRejectedValueOnce(new Error('Fee increased between queries.'))
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await useAll(tree)
    expect(texts(tree)).toContain(i18n.t('common.retry'))

    await ReactTestRenderer.act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('')
    })
    await settle()
    expect(texts(tree)).not.toContain(i18n.t('common.retry'))
  })

  test('a cross-chain send has no chip', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(synced(50_000))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [SOLANA_ROUTE] })
    const tree = await render()
    await pasteDestination(tree, '0xabc')
    await ReactTestRenderer.act(async () => {
      tree.root.findAll(n => typeof n.props.onPress === 'function' && n.findAllByType(Text).some(x => x.props.children === 'Add amount'))[0]?.props.onPress()
    })
    await settle()

    expect(sheet(tree).props.onUseAll).toBeUndefined()
  })

  describe('a token', () => {
    const depix = (balanceBaseUnits: number): SparkWalletInfo['tokens'][number] => ({
      identifier: DEPIX.identifier,
      name: DEPIX.name,
      ticker: DEPIX.ticker,
      decimals: 8,
      balanceBaseUnits,
    })
    const toToken = async (balanceBaseUnits: number, token = depix(balanceBaseUnits)) => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(synced(0, [token]))
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
      const tree = await render()
      await pasteDestination(tree, 'spark1payee')
      const row = tree.root
        .findAll(node => typeof node.props.onPress === 'function')
        .find(node => String(node.props.label ?? '').endsWith(i18n.t('send.chooseAsset')))
      await ReactTestRenderer.act(async () => row?.props.onPress())
      await pickFromSheet(tree, token.identifier)
      await pressBtn(tree, i18n.t('send.amountToken', { ticker: token.ticker }))
      return tree
    }

    // A whole balance of the token on its way to a Spark address, whose record names the Spark rail.
    const toAllOf = async (token: SparkWalletInfo['tokens'][number]) => {
      jest.mocked(sparkPrepareSend).mockResolvedValue({
        handle: 't',
        amount: token.balanceBaseUnits,
        fee: 0,
        tokenIdentifier: token.identifier,
        feesIncluded: true,
        receives: token.balanceBaseUnits,
      })
      jest.mocked(sparkConfirmSend).mockResolvedValue('complete')
      jest.mocked(sparkSentRail).mockReturnValue('spark')
      return toToken(token.balanceBaseUnits, token)
    }
    const overlayOf = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(ReceivedOverlay).props

    test('a token sent over Spark is titled by that rail and counted in its own unit', async () => {
      const tree = await toAllOf(depix(150_000_000))
      await useAll(tree)
      await pressBtn(tree, 'Confirm send')
      const overlay = overlayOf(tree)

      expect(sparkSentRail).toHaveBeenCalledWith('t')
      expect(overlay.label).toBe('Sent via the Spark network')
      expect(overlay.amount.unit).toBe('DePix')
      expect(overlay.amount.format(overlay.amount.value)).toBe('1.5')
    })

    test('a token under another identifier is never named by what it calls itself', async () => {
      const tree = await toAllOf({
        identifier: 'btkn1lookalike',
        name: USDB.name,
        ticker: 'USDB',
        decimals: 6,
        balanceBaseUnits: 2_000_000,
      })
      await useAll(tree)
      await pressBtn(tree, 'Confirm send')
      const overlay = overlayOf(tree)

      expect(overlay.amount.unit).toBe('')
      expect(overlay.beneath).toBe(i18n.t('notice.unknownToken'))
      expect(JSON.stringify([overlay.label, overlay.amount.unit, overlay.beneath])).not.toContain('USDB')
    })

    test('spends the base units as held, past any rounding by the sheet', async () => {
      jest.mocked(sparkPrepareSend).mockResolvedValue({
        handle: 't',
        amount: 123_456_789,
        fee: 0,
        tokenIdentifier: DEPIX.identifier,
        feesIncluded: true,
        receives: 123_456_789,
      })
      const tree = await toToken(123_456_789)
      // Weighed in base units, so the balance reaches the sheet as held.
      expect(sheet(tree).props.tokenBounds.available).toBe(123_456_789n)
      expect(sheet(tree).props.available).toBeUndefined()
      await useAll(tree)

      expect(sparkPrepareSend).toHaveBeenCalledWith('spark1payee', 123_456_789, DEPIX.identifier, true)
    })

    test('a balance past the safe integers offers nothing and locks nothing', async () => {
      const tree = await toToken(2 ** 53)
      expect(sheet(tree).props.available).toBeUndefined()
      expect(sheet(tree).props.tokenBounds.available).toBeUndefined()
      expect(sheet(tree).props.onUseAll).toBeUndefined()
    })
  })
})

test('auto-prepares a pasted bolt11: inspects, prepares, shows amount + fee', async () => {
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  expect(sparkInspectDestination).toHaveBeenCalledWith('lnbc1invoice')
  expect(sparkPrepareSend).toHaveBeenCalledWith('lnbc1invoice', undefined, undefined)
  const shown = texts(tree).join('').replace(/\s/g, '')
  expect(shown).toContain(formatSats(1000).replace(/\s/g, ''))
  expect(shown).toContain('5sats')
})

// While the quote is prepared the screen draws the review's shape, the figure at its display size,
// so the review lands without the screen jumping.
test('a quote being prepared draws the shape of the review it becomes', async () => {
  jest.mocked(sparkPrepareSend).mockImplementationOnce(() => new Promise(() => undefined))
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  const heights = tree.root
    .findAllByType(Skeleton)
    .filter(node => !tree.root.findAllByType(SendBalance).some(balance => balance.findAllByType(Skeleton).includes(node)))
    .map(node => node.props.height)
  expect(heights).toContain(font.leading.display)
  expect(heights).toContain(font.leading.sm)
})

// At the end of the scroll the payment sat below the fold on a short screen, drawn under the gesture
// bar of an edge-to-edge Android window and cut at the bottom edge. Screen's footer stays in view and
// carries the bottom inset (screen.test.tsx), so the action belongs there.
test("the review's Confirm send is the screen's footer, never a row at the end of the scroll", async () => {
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  const confirm = (node: ReactTestRenderer.ReactTestInstance) =>
    node.findAllByType(GradientButton).filter(button => button.props.label === i18n.t('send.confirm')).length
  const screen = tree.root.findByType(Screen)
  expect(confirm(tree.root)).toBe(1)
  expect(confirm(screen.findAllByType(ScrollView)[0]!)).toBe(0)
})

// The review's fee and total sat beside their labels at flexShrink 0, laid out past the card's edge
// and cut at a large text size. Each is a figure that gives way in its row.
test("the review's figures give way in their rows", async () => {
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  const drawn = figuresIn(tree.root).map(textOf)
  expect(drawn).toEqual(expect.arrayContaining([expect.stringContaining('5'), expect.stringContaining(formatSats(1005))]))
  expect(figuresHeldOut(tree.root)).toEqual([])
})

// Side by side at the largest text size, a fee beside "Taxa de rede" shrank to a fraction of its
// size. Below the side by side width each row puts its value under its label.
test("the review's rows stack their values under their labels at a large text size", async () => {
  const start = Dimensions.get('window')
  const window = { ...start, fontScale: 3.12 }
  ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  try {
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    // Every row that pairs a label with a figure goes through FigureRow, which owns the stacking.
    const rows = tree.root.findAllByType(FigureRow)
    expect(rows.length).toBeGreaterThan(1)
    const inRows = new Set(rows.flatMap(row => figuresIn(row)))
    const review = tree.root.findAllByType(Card).flatMap(card => figuresIn(card))
    expect(review.filter(figure => !inRows.has(figure)).map(textOf)).toEqual([])
    for (const row of rows) {
      expect(StyleSheet.flatten(hostChildren(row)[0].props.style)).toMatchObject({ flexDirection: 'column' })
    }
  } finally {
    ReactTestRenderer.act(() => Dimensions.set({ window: start, screen: start }))
  }
})

test("the review's rows are split by the app's divider hairline", async () => {
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  const flat = (raw: unknown): Record<string, unknown> =>
    Object.assign({}, ...[raw].flat(Infinity).filter(x => x && typeof x === 'object'))
  const dividers = tree.root
    .findAll(node => typeof node.type === 'string' && flat(node.props.style).borderTopWidth !== undefined)
    .map(node => flat(node.props.style).borderTopColor)
  expect(dividers.length).toBeGreaterThan(0)
  expect(new Set(dividers)).toEqual(new Set([colors.divider]))
})

test('a unified BIP21 pays the resolved rail, not the raw URI', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11', resolved: 'lnbc1resolved' })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qaddr?lightning=lnbc1resolved')

  expect(sparkPrepareSend).toHaveBeenCalledWith('lnbc1resolved', undefined, undefined)
})

test('a BIP21 that named an amount pays it without asking again (requestedAmount)', async () => {
  // A BIP21 carries its amount at requestedAmount, since the address string embeds none.
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'bitcoinAddress', resolved: 'bc1qaddr', requestedAmount: 5000 })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.00005')

  expect(sparkPrepareSend).toHaveBeenCalledWith('bc1qaddr', 5000, undefined)
})

// The address beside an expired invoice may belong to the request that ran out, so it settles late, on
// the slower network, and only when asked for.
describe('a unified code whose invoice ran out', () => {
  const URI = 'bitcoin:bc1qaddr?amount=0.00005&lightning=lnbc1expired'
  const STOP = 'This invoice has expired. Ask for a new one.'
  const TAP = 'Pay on the slower Bitcoin network instead'
  const ranOut = (requestedAmount?: number) =>
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'bitcoinAddress',
      resolved: 'bc1qaddr',
      requestedAmount,
      expiredInvoice: true,
    })

  test('says so and asks for a new one, pricing nothing and opening no keypad', async () => {
    ranOut(5000)
    const tree = await render()

    await pasteDestination(tree, URI)

    expect(texts(tree)).toEqual(expect.arrayContaining([STOP, TAP]))
    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)
  })

  test('pays the on-chain leg with its amount only after the tap that names the network', async () => {
    ranOut(5000)
    const tree = await render()
    await pasteDestination(tree, URI)

    await pressBtn(tree, TAP)

    expect(sparkPrepareSend).toHaveBeenCalledWith('bc1qaddr', 5000, undefined)
    expect(texts(tree)).not.toContain(STOP)
  })

  test('without an amount, the keypad opens after the tap and its amount does not stop again', async () => {
    ranOut(undefined)
    const tree = await render()
    await pasteDestination(tree, URI)
    expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)

    await pressBtn(tree, TAP)
    expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
    await enterAmount(tree, 20_000)

    expect(sparkPrepareSend).toHaveBeenCalledWith('bc1qaddr', 20_000, undefined)
    expect(texts(tree)).not.toContain(STOP)
  })

  test('the tap holds for that entry alone, and the same code given again asks again', async () => {
    ranOut(5000)
    // A review that fails leaves the field, and its Paste, on screen.
    jest.mocked(sparkPrepareSend).mockRejectedValueOnce(new Error('boom'))
    const tree = await render()
    await pasteDestination(tree, URI)
    await pressBtn(tree, TAP)
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    jest.mocked(sparkPrepareSend).mockClear()

    await pasteDestination(tree, URI)

    expect(texts(tree)).toContain(STOP)
    expect(sparkPrepareSend).not.toHaveBeenCalled()
  })

  const legs = {
    bitcoinAddress: { kind: 'bitcoinAddress' as const, resolved: 'bc1qaddr' },
    silentPaymentAddress: { kind: 'silentPaymentAddress' as const, resolved: 'sp1qleg' },
  }
  // Scan, Contacts and the suggestions hand the code in as a route param, and a typed code is read
  // after the field's pause, so each entry reaches the same stop.
  const entries = {
    paste: async () => {
      const tree = await render()
      await pasteDestination(tree, URI)
      return tree
    },
    'route param': async () => {
      mockRouteParams = { destination: URI, picked: 1 }
      return render()
    },
    typed: async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] })
      try {
        const tree = await render()
        await ReactTestRenderer.act(async () => {
          tree.root.findAllByType(TextInput)[0].props.onChangeText(URI)
        })
        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(400)
        })
        await settle()
        return tree
      } finally {
        jest.useRealTimers()
      }
    },
  }
  test.each([
    ['paste', 'silentPaymentAddress'],
    ['route param', 'bitcoinAddress'],
    ['route param', 'silentPaymentAddress'],
    ['typed', 'bitcoinAddress'],
    ['typed', 'silentPaymentAddress'],
  ] as const)('a %s entry with a %s leg stops, and pays that leg only after the tap', async (entry, leg) => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ ...legs[leg], requestedAmount: 5000, expiredInvoice: true })
    const tree = await entries[entry]()

    expect(texts(tree)).toEqual(expect.arrayContaining([STOP, TAP]))
    expect(sparkPrepareSend).not.toHaveBeenCalled()

    await pressBtn(tree, TAP)

    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    expect(sparkPrepareSend).toHaveBeenCalledWith(legs[leg].resolved, 5000, undefined)
    expect(texts(tree)).not.toContain(STOP)
  })

  test('an error that covers the stop takes the on-chain link with it', async () => {
    ranOut(5000)
    jest.mocked(nfcState).mockResolvedValue('off')
    jest.mocked(openNfcSettings).mockResolvedValueOnce(false)
    try {
      const tree = await render()
      await pasteDestination(tree, URI)
      expect(texts(tree)).toEqual(expect.arrayContaining([STOP, TAP]))

      await pressBtn(tree, i18n.t('send.nfcOff'))

      expect(texts(tree)).toContain(i18n.t('send.nfcSettingsFailed'))
      expect(texts(tree)).not.toContain(STOP)
      expect(texts(tree)).not.toContain(TAP)
    } finally {
      jest.mocked(nfcState).mockResolvedValue('unsupported')
    }
  })

  test('Review on a code whose invoice ran out since its review stops there, with no Review beside it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11', resolved: 'lnbc1valid' })
    const tree = await render()
    await pasteDestination(tree, URI)
    expect(texts(tree)).toContain(i18n.t('send.confirm'))
    await ReactTestRenderer.act(async () => {
      mockPreventCb?.()
    })
    await settle()
    expect(texts(tree)).toContain(i18n.t('send.review'))
    jest.mocked(sparkPrepareSend).mockClear()
    ranOut(5000)

    await pressBtn(tree, i18n.t('send.review'))

    expect(texts(tree)).toEqual(expect.arrayContaining([STOP, TAP]))
    expect(texts(tree)).not.toContain(i18n.t('send.review'))
    expect(sparkPrepareSend).not.toHaveBeenCalled()
  })
})

test('the review shows the resolved rail address, not the bitcoin: URI it was wrapped in', async () => {
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'sparkAddress', resolved: 'spark1payee', requestedAmount: 5000 })
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 5000, fee: 0 })
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 1_000_000, tokens: [] })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qonchain?amount=0.00005&spark=spark1payee')

  const shown = texts(tree).join('').replace(/\s/g, '')
  expect(shown).toContain('spark1payee')
  expect(shown).not.toContain('bc1qonchain')
})

test('a BTC amount above the balance blocks the review with a warning and a disabled confirm', async () => {
  // A BIP21-named amount skips the amount sheet, so the review is the last guard.
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'sparkAddress', resolved: 'spark1payee', requestedAmount: 500_000 })
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 500_000, fee: 0 })
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 61_264, tokens: [] })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.005&spark=spark1payee')

  expect(texts(tree).join(' ')).toContain('Not enough balance to complete.')
  expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
})

describe('the balance before the first sync', () => {
  const MARK = 'Not yet updated with the network'
  const shown = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s+/g, ' ')
  const figure = formatSats(61_264).replace(/\s+/g, ' ')

  beforeEach(() => {
    jest
      .mocked(sparkInspectDestination)
      .mockResolvedValue({ kind: 'sparkAddress', resolved: 'spark1payee', requestedAmount: 500_000 })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 500_000, fee: 0 })
  })

  test('a read before the sync is neither shown as the balance nor blocks the review', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'waiting', recoverableSat: 0, balanceSat: 61_264, tokens: [] })
    const tree = await render()

    await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.005&spark=spark1payee')

    expect(shown(tree)).not.toContain(figure)
    expect(tree.root.findByType(SendBalance).findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(shown(tree)).not.toContain('Not enough balance to complete.')
    expect(tree.root.findByType(GradientButton).props.disabled).toBe(false)
  })

  test('past the wait the stored balance shows marked, and claims nothing about it', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 61_264, tokens: [] })
    const tree = await render()

    await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.005&spark=spark1payee')

    expect(shown(tree)).toContain(figure)
    expect(shown(tree)).toContain(MARK)
    expect(shown(tree)).not.toContain('Not enough balance to complete.')
  })

  test('the sync landing on a prepared review moves the balance and keeps the quote', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'waiting', recoverableSat: 0, balanceSat: 61_264, tokens: [] })
    const tree = await render()
    await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.005&spark=spark1payee')
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)

    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 61_264, tokens: [] })
    await ReactTestRenderer.act(async () => {
      mockSynced.forEach(cb => cb())
    })
    await settle()

    expect(shown(tree)).toContain(figure)
    expect(shown(tree)).not.toContain(MARK)
    expect(shown(tree)).toContain('Not enough balance to complete.')
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
  })
})

test('a BTC amount within the balance leaves confirm enabled', async () => {
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'sparkAddress', resolved: 'spark1payee', requestedAmount: 5000 })
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 5000, fee: 0 })
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 61_264, tokens: [] })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.00005&spark=spark1payee')

  expect(texts(tree).join(' ')).not.toContain('Not enough balance to complete.')
  expect(tree.root.findByType(GradientButton).props.disabled).toBe(false)
})

// Everything sits in USDB, so blocking on the zero sat balance would refuse sends the wallet can
// make.
const DOLLAR_ONLY = {
  sync: 'synced' as const,
  recoverableSat: 0,
  balanceSat: 0,
  tokens: [
    {
      identifier: USDB.identifier,
      ticker: USDB.ticker,
      name: USDB.name,
      decimals: USDB.decimals,
      balanceBaseUnits: 47_493_695, // ~47.49 USDB
    },
  ],
}

test('a converted send is allowed with no sats: the token balance is what counts', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(DOLLAR_ONLY)
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'sparkAddress', resolved: 'spark1payee', requestedAmount: 1000 })
  // ~0.8 USDB converted, well inside the 47.49 held.
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'h1',
    amount: 1000,
    fee: 0,
    conversion: { tokenIdentifier: USDB.identifier, amountIn: 800_000, amountOut: 1000, fee: 2000 },
  })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.00001&spark=spark1payee')

  expect(texts(tree).join(' ')).not.toContain('Not enough balance to complete.')
  expect(tree.root.findByType(GradientButton).props.disabled).toBe(false)
  expect(texts(tree).join(' ')).toContain('Converts')
  expect(texts(tree).join(' ')).toContain('USDB')
})

test('a converted send beyond the token balance still blocks', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(DOLLAR_ONLY)
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'sparkAddress', resolved: 'spark1payee', requestedAmount: 5_000_000 })
  // The conversion would need 100 USDB, over the 47.49 held.
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'h1',
    amount: 5_000_000,
    fee: 0,
    conversion: { tokenIdentifier: USDB.identifier, amountIn: 100_000_000, amountOut: 5_000_000, fee: 0 },
  })
  const tree = await render()

  await pasteDestination(tree, 'bitcoin:bc1qaddr?amount=0.05&spark=spark1payee')

  expect(texts(tree).join(' ')).toContain('Not enough balance to complete.')
  expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
})

test('a token amount above the held token balance blocks the review (billed in the token unit)', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'sparkAddress', tokenIdentifier: USDB.identifier, amount: 100_000_000 })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'hi',
    amount: 100_000_000,
    fee: 0,
    tokenIdentifier: USDB.identifier,
  })
  const tree = await render()

  await pasteDestination(tree, 'sparkinvoice1usdb')

  expect(texts(tree).join(' ')).toContain('Not enough balance to complete.')
  expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
})

test('a cross-chain send that spends more sats than held blocks the review', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 40_000, tokens: [] })
  jest
    .mocked(sparkInspectDestination)
    .mockResolvedValue({ kind: 'crossChainAddress', routes: [SOLANA_ROUTE] })
  jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({
    handle: 'xc1',
    routeId: SOLANA_ROUTE.id,
    source: 'sats',
    amountIn: 50_000,
    feeSat: 120,
    estimatedOut: 49_500_000,
    feeAmount: 500_000,
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: '2099-08-06T12:00:00Z',
  })
  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')
  await enterAmount(tree, 50_000)

  expect(texts(tree).join(' ')).toContain('Not enough balance to complete.')
  expect(tree.root.findByType(GradientButton).props.disabled).toBe(true)
})

test('rejects a destination the Spark engine does not own (no prepare)', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'other' })
  const tree = await render()
  await pasteDestination(tree, 'lq1liquidaddress')

  expect(sparkPrepareSend).not.toHaveBeenCalled()
  expect(texts(tree)).toContain(i18n.t('errors.invalidInput'))
})

test('an amountless address opens the amount sheet, then prepares with the entered value', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  const tree = await render()
  await pasteDestination(tree, 'bc1qaddr')

  expect(sparkPrepareSend).not.toHaveBeenCalled()

  await enterAmount(tree, 2500)

  expect(sparkPrepareSend).toHaveBeenCalledWith('bc1qaddr', 2500, undefined)
})

test('paying a lightning address routes through the LNURL-pay flow, not the plain send', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
  jest.mocked(sparkParseLnurlPay).mockResolvedValue({
    handle: 'lnurl_1',
    minSat: 1000,
    maxSat: 100_000,
    commentAllowed: 0,
    payee: 'alice@example.com',
  })
  jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'prep_1', amount: 5000, fee: 10 })
  jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({ status: 'complete' })

  const tree = await render()
  await pasteDestination(tree, 'alice@example.com')

  // LNURL carries a range and no amount, so it must ask before quoting.
  expect(sparkParseLnurlPay).toHaveBeenCalledWith('alice@example.com')
  expect(sparkPrepareLnurlPay).not.toHaveBeenCalled()

  await enterAmount(tree, 5000)

  expect(sparkPrepareLnurlPay).toHaveBeenCalledWith('lnurl_1', 5000, undefined)
  expect(sparkPrepareSend).not.toHaveBeenCalled()

  await pressBtn(tree, 'Confirm send')
  expect(sparkConfirmLnurlPay).toHaveBeenCalledWith('prep_1')
  expect(sparkConfirmSend).not.toHaveBeenCalled()
})

test('the amount sheet is bounded by the LNURL endpoint min/max', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
  jest.mocked(sparkParseLnurlPay).mockResolvedValue({
    handle: 'lnurl_1',
    minSat: 1000,
    maxSat: 100_000,
    commentAllowed: 0,
    payee: 'alice@example.com',
  })

  const tree = await render()
  await pasteDestination(tree, 'alice@example.com')

  const sheet = tree.root.findByType(AmountSheet)
  expect(sheet.props.min).toBe(1000)
  expect(sheet.props.max).toBe(100_000)
})

test('an LNURL comment (LUD-12) reaches prepareLnurlPay when the endpoint accepts one', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
  jest.mocked(sparkParseLnurlPay).mockResolvedValue({
    handle: 'lnurl_1',
    minSat: 1000,
    maxSat: 100_000,
    commentAllowed: 120,
    payee: 'alice@example.com',
  })
  jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'prep_1', amount: 5000, fee: 10 })

  const tree = await render()
  await pasteDestination(tree, 'alice@example.com')

  const sheet = tree.root.findByType(AmountSheet)
  expect(sheet.props.commentMax).toBe(120)
  await ReactTestRenderer.act(async () => {
    sheet.props.onConfirm(5000, undefined, undefined, 'thanks!')
  })
  await settle()

  expect(sparkPrepareLnurlPay).toHaveBeenCalledWith('lnurl_1', 5000, 'thanks!')
})

test('an on-chain fee with no flat number shows the deferred label', async () => {
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h2', amount: 5000, fee: undefined })
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  expect(texts(tree).join(' ')).toContain('Fee shown at send')
})

test('an on-chain review draws the miner and Spark legs as figures that give way', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'oc1',
    amount: 20000,
    fee: undefined,
    onchainFees: {
      fast: { minerSat: 1200, sparkSat: 930, totalSat: 2130 },
      medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
      slow: { minerSat: 400, sparkSat: 930, totalSat: 1330 },
      estimate: false,
    },
  })
  const tree = await render()
  await pasteDestination(tree, 'bc1qaddr')
  await enterAmount(tree, 20000)

  await pressBtn(tree, 'Details')
  const drawn = figuresIn(tree.root).map(textOf).join(' | ')
  expect(drawn).toContain(formatSats(780))
  expect(drawn).toContain(formatSats(930))
  expect(figuresHeldOut(tree.root)).toEqual([])
})

test('an on-chain send shows the fee split by speed and confirms with the picked tier', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'oc1',
    amount: 20000,
    fee: undefined,
    onchainFees: {
      fast: { minerSat: 1200, sparkSat: 930, totalSat: 2130 },
      medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
      slow: { minerSat: 400, sparkSat: 930, totalSat: 1330 },
      estimate: false,
    },
  })
  const tree = await render()
  await pasteDestination(tree, 'bc1qaddr')
  await enterAmount(tree, 20000)

  // Default speed is medium, so the one fee is 1710 and the split waits behind Details.
  expect(texts(tree)).toContain(i18n.t('send.sats', { amount: formatSats(1710) }))
  const shown = texts(tree).join(' ')
  expect(shown).not.toContain(i18n.t('send.feeSpark'))
  expect(shown).not.toContain(formatSats(930))
  expect(shown).not.toContain('Fee shown at send')
  // A quoted fee is not called an estimate.
  expect(shown).not.toContain('Estimate')
  expect(shown).toContain('~30 min')

  await pressBtn(tree, 'Details')
  const open = texts(tree).join(' ')
  // The split names the Bitcoin network and the transfer, and "exit" stays with the emergency exit.
  expect(open).toContain(i18n.t('send.feeMiner'))
  expect(open).toContain(i18n.t('send.feeSpark'))
  expect(open).not.toMatch(/exit/i)
  expect(open).toContain(formatSats(780))
  expect(open).toContain(formatSats(930))

  await pressBtn(tree, 'Economy')
  const economy = texts(tree).join(' ')
  expect(economy).toContain('~1 hour')
  // The fold stays open across a change of speed, and follows it.
  expect(economy).toContain(formatSats(400))
  expect(economy).toContain(formatSats(1330))
  await pressBtn(tree, 'Confirm send')
  expect(sparkConfirmSend).toHaveBeenCalledWith('oc1', 'slow')
})

test('an on-chain fee the SDK only estimated is said to be one', async () => {
  // A wallet whose value is all USDB has no bitcoin leaves to quote a withdrawal against, so the
  // SDK estimates the fee and funds the send by converting. The screen has to say so: the number
  // is a ceiling, not the fee.
  // The SDK only estimates when a conversion funds the send, so the quote carries one: the label
  // has to survive the conversion rows the review draws in that state, not a layout it never has.
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'oc2',
    amount: 20000,
    fee: undefined,
    onchainFees: {
      fast: { minerSat: 1200, sparkSat: 930, totalSat: 2130 },
      medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
      slow: { minerSat: 400, sparkSat: 930, totalSat: 1330 },
      estimate: true,
    },
    conversion: { tokenIdentifier: USDB.identifier, amountIn: 22_000_000, amountOut: 21710, fee: 0 },
  })
  const tree = await render()
  await pasteDestination(tree, 'bc1qaddr')
  await enterAmount(tree, 20000)

  // The caution and what the conversion spends read without opening anything.
  const shown = texts(tree).join(' ')
  expect(shown).toContain(formatSats(1710))
  expect(shown).toContain(i18n.t('send.feeEstimated'))
  expect(shown).toContain(i18n.t('send.converts'))
  expect(shown).toContain('22 USDB')
  expect(shown).toContain(i18n.t('send.speed'))
})

describe('the review shows one fee, and the rail only where it is a choice', () => {
  const onchainQuote = {
    handle: 'oc1',
    amount: 20000,
    fee: undefined,
    onchainFees: {
      fast: { minerSat: 1200, sparkSat: 930, totalSat: 2130 },
      medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
      slow: { minerSat: 400, sparkSat: 930, totalSat: 1330 },
      estimate: false,
    },
  }

  test('an on-chain total stays the sum at the chosen speed, with the fold shut', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchainQuote)
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await enterAmount(tree, 20000)

    expect(texts(tree).join(' ')).toContain(formatSats(21710))
    await pressBtn(tree, 'Fast')
    expect(texts(tree).join(' ')).toContain(formatSats(22130))
  })

  test.each([
    ['Lightning', { kind: 'bolt11' }, 'lnbc1invoice'],
    ['Spark', { kind: 'sparkAddress' }, 'spark1addr'],
  ] as const)('%s names no network and folds nothing', async (_rail, inspected, destination) => {
    jest.mocked(sparkInspectDestination).mockResolvedValue(inspected)
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 5 })
    const tree = await render()
    await pasteDestination(tree, destination)
    await enterAmount(tree, 1000).catch(() => undefined)

    const shown = texts(tree)
    expect(shown).toContain(i18n.t('send.fee'))
    expect(shown).not.toContain(i18n.t('send.network'))
    expect(shown).not.toContain(i18n.t('send.details'))
  })

  test('on-chain names its network', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchainQuote)
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await enterAmount(tree, 20000)

    expect(texts(tree)).toEqual(
      expect.arrayContaining([i18n.t('send.network'), i18n.t('send.netOnchain')]),
    )
  })
})

describe('a silent payment address', () => {
  const SILENT = 'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv'
  const onchain = {
    handle: 'sp1',
    amount: 20_000,
    fee: 1000,
    onchainFees: {
      fast: { minerSat: 1200, sparkSat: 930, totalSat: 2130 },
      medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
      slow: { minerSat: 400, sparkSat: 930, totalSat: 1330 },
      estimate: false,
    },
  }
  const toSheet = async (typed = SILENT) => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'silentPaymentAddress', resolved: SILENT })
    const tree = await render()
    await pasteDestination(tree, typed)
    return tree
  }

  test('asks for the amount first, as a bitcoin address does', async () => {
    const tree = await toSheet()

    expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
    expect(sparkPrepareSend).not.toHaveBeenCalled()
  })

  test('reviews with the amount, the fee, the whole destination and its rail named', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchain)
    const tree = await toSheet()
    await enterAmount(tree, 20_000)

    const shown = texts(tree)
    expect(sparkPrepareSend).toHaveBeenCalledWith(SILENT, 20_000, undefined)
    expect(shown).toContain(formatSats(20_000))
    expect(shown).toContain(`${formatSats(1710)} sats`)
    expect(shown).toEqual(
      expect.arrayContaining([
        i18n.t('send.network'),
        i18n.t('send.netSilentPayment'),
        i18n.t('send.fee'),
        i18n.t('send.etaMedium'),
      ]),
    )
    expect(shown).not.toContain(i18n.t('send.netOnchain'))
    // Grouped in full, so every character can be checked, and never cut in the middle as an invoice is.
    const drawn = tree.root.findByType(ChunkedAddress).props
    expect(drawn).toMatchObject({ value: SILENT, chunked: true })
  })

  test('a bitcoin address keeps the plain name of its rail', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchain)
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await enterAmount(tree, 20_000)

    expect(texts(tree)).not.toContain(i18n.t('send.netSilentPayment'))
  })

  test('confirms at the chosen speed, as a bitcoin address does, and lands as on its way', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchain)
    jest.mocked(sparkConfirmSend).mockResolvedValue('pending')
    const tree = await toSheet()
    await enterAmount(tree, 20_000)
    await pressBtn(tree, 'Fast')

    await pressBtn(tree, 'Confirm send')

    expect(sparkConfirmSend).toHaveBeenCalledWith('sp1', 'fast')
    expect(sparkFollowSend).not.toHaveBeenCalled()
    expect(tree.root.findByType(ReceivedOverlay).props.label).toBe(i18n.t('send.onTheWay'))
  })

  test('a quote that fails reads as a bitcoin address reads, with no review', async () => {
    jest.mocked(sparkPrepareSend).mockRejectedValue(new Error('boom'))
    const tree = await toSheet()
    await enterAmount(tree, 20_000).catch(() => undefined)

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree)).toContain(i18n.t('send.reviewFailed'))
  })

  test('a quote still out shows the skeleton and no figure', async () => {
    jest.mocked(sparkPrepareSend).mockReturnValue(new Promise(() => undefined))
    const tree = await toSheet()
    await enterAmount(tree, 20_000).catch(() => undefined)

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).not.toContain(formatSats(1710))
  })

  test('a balance still waiting for its sync refuses nothing, and the SDK decides', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchain)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      balanceSat: 0,
      recoverableSat: 0,
      tokens: [],
      sync: 'waiting',
    })
    const tree = await toSheet()
    await enterAmount(tree, 20_000)

    expect(texts(tree).join(' ')).not.toContain(i18n.t('errors.insufficientFunds'))
  })

  // The parser read it whole, so the connection is no part of the answer, unlike a bad checksum.
  test('an address for another network is refused, whatever the sync says', async () => {
    mockSyncState.current = 'stale'
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'wrongNetwork' })
    const tree = await render()
    await pasteDestination(tree, 'tsp1qaddress')
    mockSyncState.current = 'synced'

    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('send.unsupported'))
    expect(texts(tree)).not.toContain(i18n.t('errors.offline'))
  })

  test('a bad checksum reads as text not recognized, as Scan reads it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'other' })
    const tree = await render()
    await pasteDestination(tree, `${SILENT.slice(0, -1)}q`)

    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('errors.invalidInput'))
  })
})

describe('the fee follows the rail that runs', () => {
  afterEach(() => {
    mockSparkRoute.on = false
  })

  test('shipped off, an invoice that allows Spark still pays and shows Lightning', async () => {
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 7, sparkRouteFeeSat: 0 })
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    expect(texts(tree).join(' ')).toContain(formatSats(1007))
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('h1', undefined)
  })

  test('with the route on, the Spark fee is the one shown and the one asked for', async () => {
    mockSparkRoute.on = true
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 7, sparkRouteFeeSat: 0 })
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    const shown = texts(tree).join(' ')
    expect(shown).not.toContain(formatSats(1007))
    expect(shown).toContain(i18n.t('send.sats', { amount: formatSats(0) }))
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('h1', undefined, undefined, true)
  })

  test('with the route on, an invoice without the field stays on Lightning, fee and options', async () => {
    mockSparkRoute.on = true
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 7 })
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    expect(texts(tree).join(' ')).toContain(formatSats(1007))
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('h1', undefined)
  })
})

test("shows the payee's memo (the bolt11 description) on the review", async () => {
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'h1',
    amount: 1000,
    fee: 5,
    description: 'Coffee at Satoshi Cafe',
  })
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  expect(texts(tree).join(' ')).toContain('Coffee at Satoshi Cafe')
})

test('confirming sends via the handle, then hands off to the success overlay', async () => {
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  await pressBtn(tree, 'Confirm send')

  // A non-onchain send has no confirmation-speed tier, so the second arg is undefined.
  expect(sparkConfirmSend).toHaveBeenCalledWith('h1', undefined)
  // Only a failed send keeps the review, so the button's absence pins that it was not reported failed.
  const hasConfirm = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .some(n => n.findAllByType(Text).some(txt => txt.props.children === 'Confirm send'))
  expect(hasConfirm).toBe(false)
})

test('while a send is confirming the button keeps its label beside the spinner', async () => {
  jest.mocked(sparkConfirmSend).mockImplementationOnce(() => new Promise(() => undefined))
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')
  await pressBtn(tree, i18n.t('send.confirm'))

  const button = tree.root
    .findAllByType(GradientButton)
    .find(node => node.props.onPress && node.props.loading)
  expect(button?.props.label).toBe(i18n.t('send.confirm'))
})

test('back on the review drops the quote and stays on the screen', async () => {
  const tree = await render()
  expect(mockPreventActive).toBe(false)
  await pasteDestination(tree, 'lnbc1invoice')
  expect(mockPreventActive).toBe(true)

  await ReactTestRenderer.act(async () => {
    mockPreventCb?.()
  })
  await settle()

  const hasConfirm = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .some(n => n.findAllByType(Text).some(txt => txt.props.children === 'Confirm send'))
  expect(hasConfirm).toBe(false)
  // Released again, so the next back leaves the screen as usual.
  expect(mockPreventActive).toBe(false)
})

test('a sent payment releases back, so the success overlay can leave the screen', async () => {
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')
  expect(mockPreventActive).toBe(true)

  await pressBtn(tree, 'Confirm send')

  expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(1)
  expect(mockPreventActive).toBe(false)
})

test('back while a confirm is in flight keeps the quote the overlay reports', async () => {
  let settleSend: (status: 'complete') => void = () => {}
  jest.mocked(sparkConfirmSend).mockReturnValue(
    new Promise(resolve => {
      settleSend = resolve
    }),
  )
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')
  await pressBtn(tree, 'Confirm send')

  await ReactTestRenderer.act(async () => {
    mockPreventCb?.()
  })
  await ReactTestRenderer.act(async () => {
    settleSend('complete')
  })
  await settle()

  expect(tree.root.findByType(ReceivedOverlay).props.amount.value).toBe(1000)
})

function confirmButton(tree: ReactTestRenderer.ReactTestRenderer) {
  return tree.root
    .findAllByType(GradientButton)
    .find(node => node.props.label === i18n.t('send.confirm'))
}

// The handle is spent before the send, so a Confirm left on screen after a failure could do nothing.
test('a failed send keeps the review and shows the error inline, with no overlay and no second confirm', async () => {
  jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
  const tree = await render()
  await pasteDestination(tree, 'lnbc1invoice')

  await pressBtn(tree, 'Confirm send')

  expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
  expect(confirmButton(tree)).toBeUndefined()
  expect(texts(tree).join(' ')).toContain('Could not send')
  // The SDK said failed, so nothing is left in doubt.
  expect(texts(tree).join(' ')).not.toContain(i18n.t('send.checkHistory'))
  expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
})

describe('what a confirm says it did', () => {
  const overlayLabel = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findByType(ReceivedOverlay).props.label

  async function toInvoice(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    return tree
  }
  async function toSpark(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'sp1sparkaddress')
    await enterAmount(tree, 4200)
    return tree
  }
  async function toLnurl(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    jest.mocked(sparkParseLnurlPay).mockResolvedValue({
      handle: 'lnurl_1',
      minSat: 1000,
      maxSat: 100_000,
      commentAllowed: 0,
      payee: 'alice@example.com',
    })
    jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'h1', amount: 5000, fee: 10 })
    jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({ status: 'pending' })
    const tree = await render()
    await pasteDestination(tree, 'alice@example.com')
    await enterAmount(tree, 5000)
    return tree
  }
  const paths = [
    ['an invoice', toInvoice],
    ['a Spark address', toSpark],
    ['an LNURL pay', toLnurl],
  ] as const

  beforeEach(() => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('pending')
  })

  test.each(paths)('%s still pending past the wait is on the way, never sent', async (_, open) => {
    const tree = await open()
    await pressBtn(tree, 'Confirm send')

    expect(sparkFollowSend).toHaveBeenCalledTimes(1)
    expect(sparkFollowSend).toHaveBeenCalledWith('h1')
    expect(overlayLabel(tree)).toBe(i18n.t('send.onTheWay'))
    // The clock instead of the check, with the line saying the record tells its end.
    expect(tree.root.findByType(ReceivedOverlay).props.pending).toBe(i18n.t('send.pendingTold'))
  })

  // An invoice the payee holds stays pending past the wait. The rail is the record's, and the words stay
  // those of a send on its way.
  test('a Lightning send still pending names Lightning and is never called sent', async () => {
    jest.mocked(sparkSentRail).mockReturnValue('lightning')
    const tree = await toInvoice()
    await pressBtn(tree, 'Confirm send')

    expect(sparkSentRail).toHaveBeenCalledWith('h1')
    expect(overlayLabel(tree)).toBe('On the way via Lightning')
    expect(tree.root.findByType(ReceivedOverlay).props.pending).toBe(i18n.t('send.pendingTold'))
    expect(JSON.stringify(tree.root.findByType(ReceivedOverlay).props)).not.toMatch(/Sent|went through/)
  })

  // An invoice can be paid over Spark, so the quote's kind is not what the overlay names.
  test('an invoice the record says went over Spark is titled Spark', async () => {
    jest.mocked(sparkFollowSend).mockResolvedValue('complete')
    jest.mocked(sparkSentRail).mockReturnValue('spark')
    const tree = await toInvoice()
    await pressBtn(tree, 'Confirm send')

    expect(overlayLabel(tree)).toBe('Sent via the Spark network')
  })

  test('an on-chain send names the Bitcoin network', async () => {
    jest.mocked(sparkSentRail).mockReturnValue('bitcoin')
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'h1',
      amount: 20_000,
      fee: 0,
      onchainFees: {
        fast: { minerSat: 900, sparkSat: 900, totalSat: 1800 },
        medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
        slow: { minerSat: 500, sparkSat: 900, totalSat: 1400 },
        estimate: false,
      },
    })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await enterAmount(tree, 20000)
    await pressBtn(tree, 'Confirm send')

    expect(overlayLabel(tree)).toBe('On the way via the Bitcoin network')
  })

  test.each(paths)('%s that completes in the wait is sent', async (_, open) => {
    jest.mocked(sparkFollowSend).mockResolvedValue('complete')
    const tree = await open()
    await pressBtn(tree, 'Confirm send')

    expect(overlayLabel(tree)).toBe(i18n.t('send.sent'))
    expect(tree.root.findByType(ReceivedOverlay).props.pending).toBeUndefined()
  })

  test('an on-chain send, pending by nature, gets the clock and the line too', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'h1',
      amount: 20_000,
      fee: 0,
      onchainFees: {
        fast: { minerSat: 900, sparkSat: 900, totalSat: 1800 },
        medium: { minerSat: 780, sparkSat: 930, totalSat: 1710 },
        slow: { minerSat: 500, sparkSat: 900, totalSat: 1400 },
        estimate: false,
      },
    })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await enterAmount(tree, 20000)
    await pressBtn(tree, 'Confirm send')

    expect(sparkFollowSend).not.toHaveBeenCalled()
    expect(overlayLabel(tree)).toBe(i18n.t('send.onTheWay'))
    expect(tree.root.findByType(ReceivedOverlay).props.pending).toBe(i18n.t('send.pendingTold'))
  })

  test.each(paths)('%s that fails in the wait is an error with no overlay', async (_, open) => {
    jest.mocked(sparkFollowSend).mockResolvedValue('failed')
    const tree = await open()
    await pressBtn(tree, 'Confirm send')

    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
    expect(texts(tree).join(' ')).toContain('Could not send')
    expect(confirmButton(tree)).toBeUndefined()
  })

  // The server's own words are a stranger's, so they never reach the line.
  test("an LNURL server's refusal names the recipient's service and keeps its words off", async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    jest.mocked(sparkParseLnurlPay).mockResolvedValue({
      handle: 'lnurl_1',
      minSat: 1000,
      maxSat: 100_000,
      commentAllowed: 0,
      payee: 'alice@example.com',
    })
    jest.mocked(sparkPrepareLnurlPay).mockRejectedValue(
      Object.assign(new Error('SdkError.LnurlError'), {
        tag: 'LnurlError',
        inner: Object.freeze(['endpoint error: Payment over the limit of alice, call +1 555 0100']),
      }),
    )
    const tree = await render()
    await pasteDestination(tree, 'alice@example.com')
    await enterAmount(tree, 5000).catch(() => undefined)

    expect(sparkPrepareLnurlPay).toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('errors.lnurlRefused'))
    expect(texts(tree)).not.toContain(i18n.t('send.reviewFailed'))
    expect(texts(tree).join(' ')).not.toContain('over the limit')
  })

  test('a send the SDK already called complete has nothing to wait for', async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('complete')
    const tree = await toInvoice()
    await pressBtn(tree, 'Confirm send')

    expect(sparkFollowSend).not.toHaveBeenCalled()
    expect(overlayLabel(tree)).toBe(i18n.t('send.sent'))
  })

  test('the spinner stays up for the wait, and back does nothing during it', async () => {
    jest.mocked(sparkFollowSend).mockReturnValue(new Promise(() => undefined))
    const tree = await toInvoice()
    await pressBtn(tree, 'Confirm send')

    expect(confirmButton(tree)?.props.loading).toBe(true)
    await ReactTestRenderer.act(async () => {
      mockPreventCb?.()
    })
    await settle()
    expect(confirmButton(tree)?.props.loading).toBe(true)
  })

  test('an on-chain send does not wait: it lands minutes later', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'oc1', amount: 20000, fee: 500 })
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    await enterAmount(tree, 20000)
    await pressBtn(tree, 'Confirm send')

    expect(sparkFollowSend).not.toHaveBeenCalled()
    expect(overlayLabel(tree)).toBe(i18n.t('send.onTheWay'))
  })

  test.each(['pending', 'complete'] as const)(
    'a cross-chain send does not wait and is on the way even at %s',
    async status => {
      jest.mocked(sparkConfirmSend).mockResolvedValue(status)
      jest.mocked(sparkInspectDestination).mockResolvedValue({
        kind: 'crossChainAddress',
        routes: [SOLANA_ROUTE],
      })
      jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({
        handle: 'xc1',
        routeId: SOLANA_ROUTE.id,
        source: 'sats',
        amountIn: 50_000,
        feeSat: 120,
        estimatedOut: 49_500_000,
        feeAmount: 500_000,
        chain: 'solana',
        asset: 'USDC',
        decimals: 6,
        provider: 'orchestra',
        expiresAt: '2099-08-06T12:00:00Z',
      })
      const tree = await render()
      await pasteDestination(tree, 'SoLaNaAddr111')
      await enterAmount(tree, 50_000)
      await pressBtn(tree, 'Confirm send')

      expect(sparkFollowSend).not.toHaveBeenCalled()
      expect(overlayLabel(tree)).toBe(i18n.t('send.onTheWay'))
    },
  )

  // The end of a send past the wait is the record's to tell (spark.ts, sweepPendingSends), once and
  // on the wallet that sent it, so the screen hands the send over and raises nothing itself.
  test('a send past the wait is handed to the record, and the screen raises no notice of its own', async () => {
    const shown = jest.fn()
    setForegroundNoticeHandler(shown)
    const tree = await toInvoice()
    await pressBtn(tree, 'Confirm send')
    expect(overlayLabel(tree)).toBe(i18n.t('send.onTheWay'))

    ReactTestRenderer.act(() => {
      tree.unmount()
    })
    mounted = null
    setForegroundNoticeHandler(null)

    expect(jest.mocked(sparkFollowSend).mock.calls[0]).toHaveLength(1)
    expect(shown).not.toHaveBeenCalled()
  })
})

describe('Try again on a send in doubt (SND-02)', () => {
  const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  const button = (tree: ReactTestRenderer.ReactTestRenderer, key: string) =>
    tree.root.findAllByType(GradientButton).find(node => node.props.label === i18n.t(key))
  const tryAgain = (tree: ReactTestRenderer.ReactTestRenderer) => button(tree, 'common.retry')
  const keyOf = (call: number) => jest.mocked(sparkConfirmSendHeld).mock.calls[call][1]
  const overlayLabel = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findByType(ReceivedOverlay).props.label

  beforeEach(() => {
    jest.mocked(sparkSendTakesKey).mockReturnValue(true)
    jest.mocked(sparkConfirmSendHeld).mockRejectedValue(new Error('Network request failed'))
  })
  afterEach(() => {
    jest.mocked(sparkSendTakesKey).mockReturnValue(false)
  })

  async function inDoubt(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    await pressBtn(tree, 'Confirm send')
    return tree
  }

  test('the first confirm of a send that takes a key draws one for it and sends under it', async () => {
    jest.mocked(sparkConfirmSendHeld).mockResolvedValue('complete')
    const tree = await inDoubt()

    expect(sparkSendTakesKey).toHaveBeenCalledWith('h1')
    expect(sparkConfirmSendHeld).toHaveBeenCalledWith('h1', expect.stringMatching(UUID_V4), undefined, false)
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(1)
  })

  test('a send that threw keeps the doubt and offers Try again beside it, with no second confirm', async () => {
    const tree = await inDoubt()

    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeDefined()
    expect(button(tree, 'send.backToDestination')).toBeDefined()
    expect(confirmButton(tree)).toBeUndefined()
  })

  test('Try again sends the held request under the key it first went out with, and prepares nothing', async () => {
    jest.mocked(sparkRetryHeldSend).mockResolvedValue({ status: 'complete' })
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkRetryHeldSend).toHaveBeenCalledWith('h1', keyOf(0))
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    expect(sparkConfirmSendHeld).toHaveBeenCalledTimes(1)
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(tree.root.findByType(ReceivedOverlay).props.amount.value).toBe(1000)
    expect(overlayLabel(tree)).toBe(i18n.t('send.sent'))
  })

  test('a send found on its way shows On the way through the follow, as a confirm would', async () => {
    jest.mocked(sparkRetryHeldSend).mockResolvedValue({ status: 'pending' })
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkFollowSend).toHaveBeenCalledWith('h1')
    expect(overlayLabel(tree)).toBe(i18n.t('send.onTheWay'))
  })

  test('a send found failed shows the failure and offers no retry', async () => {
    jest.mocked(sparkRetryHeldSend).mockResolvedValue({ status: 'failed' })
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(texts(tree)).toContain(i18n.t('send.failed'))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeUndefined()
    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
    expect(sparkDropHeldSend).toHaveBeenCalledWith('h1')
  })

  test('a read with no answer keeps the doubt and Try again, and shows no outcome', async () => {
    jest.mocked(sparkRetryHeldSend).mockResolvedValue({ read: 'unknown' })
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeDefined()
    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
    expect(sparkDropHeldSend).not.toHaveBeenCalled()
  })

  test('a retry turned away as an invoice already used says so and keeps the doubt, which may be its own', async () => {
    jest.mocked(sparkRetryHeldSend).mockRejectedValue(
      Object.assign(new Error('SdkError.SparkError'), {
        tag: 'SparkError',
        inner: Object.freeze(['status: AlreadyExists, message: "preimage request already exists"']),
      }),
    )
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(texts(tree)).toContain(i18n.t('errors.invoiceUsed'))
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeDefined()
  })

  test('a keyed send turned away at the confirm as an invoice already used keeps the doubt and Try again', async () => {
    jest.mocked(sparkConfirmSendHeld).mockRejectedValue(
      Object.assign(new Error('SdkError.SparkError'), {
        tag: 'SparkError',
        inner: Object.freeze(['status: AlreadyExists, message: "preimage request already exists"']),
      }),
    )
    const tree = await inDoubt()

    expect(texts(tree)).toContain(i18n.t('errors.invoiceUsed'))
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeDefined()
    expect(sparkDropHeldSend).not.toHaveBeenCalled()
  })

  test('a retry turned away keeps the doubt, since the first attempt is still unaccounted for', async () => {
    jest.mocked(sparkRetryHeldSend).mockRejectedValue(new Error('Fee increased since prepare. Please retry.'))
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeDefined()
  })

  test('READS: while the read is out Try again is busy, and a second press asks nothing', async () => {
    let answer!: (value: { read: 'unknown' }) => void
    jest.mocked(sparkRetryHeldSend).mockReturnValue(new Promise(resolve => (answer = resolve)))
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('common.retry'))
    expect(tryAgain(tree)?.props.loading).toBe(true)
    expect(button(tree, 'send.backToDestination')?.props.disabled).toBe(true)
    await ReactTestRenderer.act(async () => {
      tryAgain(tree)?.props.onPress()
    })

    expect(sparkRetryHeldSend).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => answer({ read: 'unknown' }))
    await settle()
  })

  test('Back to destination lets the held send go, and the next request draws its own key', async () => {
    const tree = await inDoubt()

    await pressBtn(tree, i18n.t('send.backToDestination'))

    expect(sparkDropHeldSend).toHaveBeenCalledWith('h1')
    expect(tryAgain(tree)).toBeUndefined()
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h2', amount: 1000, fee: 5 })
    await pasteDestination(tree, 'lnbc1other')
    expect(tryAgain(tree)).toBeUndefined()
    await pressBtn(tree, 'Confirm send')

    expect(sparkConfirmSendHeld).toHaveBeenLastCalledWith('h2', expect.stringMatching(UUID_V4), undefined, false)
    expect(keyOf(1)).not.toBe(keyOf(0))
  })

  test('back on the review lets the held send go, as it lets the quote go', async () => {
    const tree = await inDoubt()

    await ReactTestRenderer.act(async () => {
      mockPreventCb?.()
    })
    await settle()

    expect(sparkDropHeldSend).toHaveBeenCalledWith('h1')
    expect(tryAgain(tree)).toBeUndefined()
  })

  test('READS: an answer that comes after the screen went shows nothing', async () => {
    let answer!: (value: { status: 'complete' }) => void
    jest.mocked(sparkRetryHeldSend).mockReturnValue(new Promise(resolve => (answer = resolve)))
    const tree = await inDoubt()
    await pressBtn(tree, i18n.t('common.retry'))

    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    mounted = null
    await ReactTestRenderer.act(async () => answer({ status: 'complete' }))

    expect(sparkDropHeldSend).toHaveBeenCalledWith('h1')
    expect(sparkFollowSend).not.toHaveBeenCalled()
  })

  test('a send that takes no key goes as a plain send and offers no Try again when it throws', async () => {
    jest.mocked(sparkSendTakesKey).mockReturnValue(false)
    jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('Network request failed'))
    const tree = await inDoubt()

    expect(sparkConfirmSend).toHaveBeenCalledWith('h1', undefined)
    expect(sparkConfirmSendHeld).not.toHaveBeenCalled()
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tryAgain(tree)).toBeUndefined()
  })

  test('a send turned away at the confirm left nothing in doubt, so it is priced again and nothing is held', async () => {
    jest.mocked(sparkConfirmSendHeld).mockRejectedValue(new Error('Fee increased since prepare. Please retry.'))
    const tree = await inDoubt()

    expect(tryAgain(tree)).toBeUndefined()
    expect(confirmButton(tree)).toBeDefined()
  })

  test('a keyed LNURL pay goes under its key, and Try again asks for the held pay under that key', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    jest.mocked(sparkParseLnurlPay).mockResolvedValue({
      handle: 'lnurl_1',
      minSat: 1000,
      maxSat: 100_000,
      commentAllowed: 0,
      payee: 'alice@example.com',
    })
    jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'prep_1', amount: 5000, fee: 10 })
    jest.mocked(sparkConfirmLnurlPay).mockRejectedValue(new Error('Network request failed'))
    jest.mocked(sparkRetryHeldSend).mockResolvedValue({ status: 'complete' })
    const tree = await render()
    await pasteDestination(tree, 'alice@example.com')
    await enterAmount(tree, 5000)

    await pressBtn(tree, 'Confirm send')

    expect(sparkConfirmLnurlPay).toHaveBeenCalledTimes(1)
    expect(sparkConfirmLnurlPay).toHaveBeenCalledWith('prep_1', expect.stringMatching(UUID_V4))
    expect(sparkConfirmSendHeld).not.toHaveBeenCalled()
    const key = jest.mocked(sparkConfirmLnurlPay).mock.calls[0][1]
    expect(tryAgain(tree)).toBeDefined()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkRetryHeldSend).toHaveBeenCalledWith('prep_1', key)
    expect(sparkConfirmLnurlPay).toHaveBeenCalledTimes(1)
  })

  // spark.ts holds every keyed send that throws, so one the screen does not keep in doubt is let go
  // at once rather than left held until a restart.
  test.each([
    ['a fee that moved', () => new Error('Fee increased since prepare. Please retry.')],
    [
      'an invoice that ran out',
      () => Object.assign(new Error('SdkError.Generic'), { tag: 'Generic', inner: Object.freeze(['invoice has expired']) }),
    ],
    ['an exit under way', () => new SpendHeldByExit('exit')],
    ['an exit plan that cannot be read', () => new SpendHeldByExit('unread')],
  ])('a keyed send that never left (%s) is let go in spark.ts', async (_why, cause) => {
    jest.mocked(sparkConfirmSendHeld).mockRejectedValue(cause())
    const tree = await inDoubt()

    expect(sparkConfirmSendHeld).toHaveBeenCalledTimes(1)
    expect(sparkDropHeldSend).toHaveBeenCalledWith('h1')
    expect(tryAgain(tree)).toBeUndefined()
  })

  test('a keyed send in doubt stays held while the screen keeps it', async () => {
    const tree = await inDoubt()

    expect(tryAgain(tree)).toBeDefined()
    expect(sparkDropHeldSend).not.toHaveBeenCalled()
  })
})

describe('a confirm that ended without an overlay', () => {
  const backButton = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByType(GradientButton)
      .find(node => node.props.label === i18n.t('send.backToDestination'))

  test('a send that threw may have gone out, so it says to check History and offers no second confirm', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('Network request failed'))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
  })

  test('a fee the SDK refused left nothing behind, so it is priced again and nothing asks to check the history', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(new Error('Fee increased since prepare. Please retry.'))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(sparkPrepareSend).toHaveBeenCalledTimes(2)
    expect(confirmButton(tree)).toBeDefined()
    expect(texts(tree)).toContain(i18n.t('send.feeMovedReview'))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('send.checkHistory'))
  })

  // tonic's display of the operators' gRPC status, as SdkError::SparkError carries it in inner[0].
  const usedInvoice = () =>
    Object.assign(new Error('SdkError.SparkError'), {
      tag: 'SparkError',
      inner: Object.freeze([
        'Service error: service connection error: Connection error: status: AlreadyExists, message: "preimage request already exists", details: [], metadata: MetadataMap { headers: {} }',
      ]),
    })

  // The payment the operators hold may be this send's own, which the SDK finishes on a later sync
  // after a probe that failed (spark transfer.rs recover_committed_transfer, lightning_sender.rs).
  test('an invoice the operators already hold a payment for says so and keeps the doubt', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(usedInvoice())
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree)).toContain(i18n.t('errors.invoiceUsed'))
    expect(texts(tree)).not.toContain(i18n.t('send.failed'))
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
  })

  test('the line for an invoice already used asks for no new invoice', () => {
    expect(i18n.t('errors.invoiceUsed')).not.toMatch(/\bnew\b/i)
    expect(i18n.t('errors.invoiceUsed')).toMatch(/this wallet/i)
  })

  // AlreadyExists names an invoice only on an invoice's send, so anything else keeps today's doubt.
  test('the same status on a Spark send keeps the generic words and the doubt', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    jest.mocked(sparkConfirmSend).mockRejectedValue(usedInvoice())
    const tree = await render()
    await pasteDestination(tree, 'sp1sparkaddress')
    await enterAmount(tree, 4200)

    await pressBtn(tree, 'Confirm send')

    expect(texts(tree)).toContain(i18n.t('send.failed'))
    expect(texts(tree)).not.toContain(i18n.t('errors.invoiceUsed'))
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
  })

  test('leaves the SDK could not reserve say the balance is still updating', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(
      Object.assign(new Error('SdkError.SparkError'), {
        tag: 'SparkError',
        inner: Object.freeze(['Tree service error: generic error: Failed to select leaves after all retries']),
      }),
    )
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(texts(tree)).toContain(i18n.t('errors.balanceSettling'))
    expect(texts(tree)).not.toContain(i18n.t('send.failed'))
  })

  test('an unknown error keeps the words it had', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(
      Object.assign(new Error('SdkError.SparkError'), { tag: 'SparkError', inner: Object.freeze(['boom']) }),
    )
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(texts(tree)).toContain(i18n.t('send.failed'))
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
  })

  // As the binding throws it: the class name in the message, the sentence only in inner[0].
  const lapsed = () =>
    Object.assign(new Error('SdkError.InvalidInput'), {
      tag: 'InvalidInput',
      inner: Object.freeze(['Invoice has expired']),
    })

  test('an invoice that lapsed on the review says so, and nothing asks to check the history', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(lapsed())
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree)).toContain(i18n.t('errors.expiredInvoice'))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('send.checkHistory'))
  })

  test('other words about something expired stay in doubt, since only the SDK sentence clears a send', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('session expired'))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
  })

  test('an invoice already lapsed stops at the destination, with no review to confirm', async () => {
    jest.mocked(sparkPrepareSend).mockRejectedValue(lapsed())
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree)).toContain(i18n.t('errors.expiredInvoice'))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('send.reviewFailed'))
  })

  test('a follow that threw reads the same as a send that threw', async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('pending')
    jest.mocked(sparkFollowSend).mockRejectedValue(new Error('boom'))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')

    await pressBtn(tree, 'Confirm send')

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).toContain(i18n.t('send.checkHistory'))
  })

  test('the way out goes back to the destination', async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    await pressBtn(tree, 'Confirm send')

    await pressBtn(tree, i18n.t('send.backToDestination'))

    expect(backButton(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).toContain(i18n.t('send.destination'))
    expect(texts(tree).join(' ')).not.toContain('Could not send')
    expect(mockPreventActive).toBe(false)
  })

  test("the system's back goes there too", async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    await pressBtn(tree, 'Confirm send')

    await ReactTestRenderer.act(async () => {
      mockPreventCb?.()
    })
    await settle()

    expect(backButton(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).toContain(i18n.t('send.destination'))
  })

  test('a new quote is a new confirm, since only the spent handle is shut', async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    await pressBtn(tree, 'Confirm send')
    await pressBtn(tree, i18n.t('send.backToDestination'))

    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h2', amount: 1000, fee: 5 })
    await pasteDestination(tree, 'lnbc1invoice')

    expect(confirmButton(tree)).toBeDefined()
    expect(backButton(tree)).toBeUndefined()
    expect(texts(tree).join(' ')).not.toContain('Could not send')
  })
})

// --- Token sends ---

test('sending USDB passes the token identifier and scales the amount to base units', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'ht',
    amount: 2_000_000,
    fee: 0,
    tokenIdentifier: USDB.identifier,
  })

  const tree = await render()
  await pasteDestination(tree, 'sp1sparkaddress')

  // With tokens in the wallet the asset comes first, so no amount was asked for yet.
  expect(sparkPrepareSend).not.toHaveBeenCalled()

  await pressBtn(tree, 'Asset')
  await pickFromSheet(tree, USDB.identifier)
  await pressBtn(tree, 'Amount in USDB')
  // 2 USDB at 6 decimals is 2_000_000 base units, and passing 2 through sends a millionth of it.
  await enterAmount(tree, 2)

  expect(sparkPrepareSend).toHaveBeenCalledWith('sp1sparkaddress', 2_000_000n, USDB.identifier)
})

// A double carries about 15 significant digits, so a token at 18 places typed as 1.000000000000000001
// would leave as 1 if the figure passed through one. Six places are the control.
describe('a typed token amount is sent as typed', () => {
  const EIGHTEEN = {
    identifier: 'btkn1eighteenplaces',
    ticker: 'EIGHT',
    name: 'Eighteen',
    decimals: 18,
    // 5 EIGHT, past the safe integers, so the sheet locks nothing and the figure alone is weighed.
    balanceBaseUnits: 5e18,
  }

  test.each([
    [EIGHTEEN.identifier, EIGHTEEN.ticker, '1.000000000000000001', 1_000_000_000_000_000_001n],
    [USDB.identifier, USDB.ticker, '1.000001', 1_000_001n],
  ])('%s: exactly the base units typed', async (identifier, ticker, typed, base) => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...WITH_USDB, tokens: [...WITH_USDB.tokens, EIGHTEEN] })
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })

    const tree = await render()
    await pasteDestination(tree, 'sp1sparkaddress')
    await pressBtn(tree, 'Asset')
    await pickFromSheet(tree, identifier)
    await pressBtn(tree, i18n.t('send.amountToken', { ticker }))
    await enterAmount(tree, typed)

    expect(sparkPrepareSend).toHaveBeenCalledWith('sp1sparkaddress', base, identifier)
  })

  // The quote's `amount` went through a double, so the review draws the SDK's exact figure instead.
  test.each([
    [false, '1.000000000000000003', undefined],
    [true, '1.000000000000000001', '0.999999999999999999'],
  ])('the review draws what is signed (fees included: %s)', async (feesIncluded, total, got) => {
    jest
      .mocked(sparkGetWalletInfo)
      .mockResolvedValue({ ...WITH_USDB, tokens: [...WITH_USDB.tokens, EIGHTEEN] })
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'ht',
      amount: Number(1_000_000_000_000_000_001n),
      amountBase: 1_000_000_000_000_000_001n,
      fee: 2,
      tokenIdentifier: EIGHTEEN.identifier,
      ...(feesIncluded ? { feesIncluded: true, receives: Number(999_999_999_999_999_999n) } : {}),
    })

    const tree = await render()
    await pasteDestination(tree, 'sp1sparkaddress')
    await pressBtn(tree, 'Asset')
    await pickFromSheet(tree, EIGHTEEN.identifier)
    await pressBtn(tree, i18n.t('send.amountToken', { ticker: EIGHTEEN.ticker }))
    await enterAmount(tree, '1.000000000000000001')

    const shown = texts(tree)
    expect(shown).toContain('1.000000000000000001')
    expect(shown).toContain(i18n.t('send.tokenFee', { amount: total, ticker: EIGHTEEN.ticker }))
    if (got) {
      expect(shown).toContain(i18n.t('send.tokenFee', { amount: got, ticker: EIGHTEEN.ticker }))
    }
  })

  test('sats are unchanged', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'sp1sparkaddress')
    await enterAmount(tree, 1234)

    expect(sparkPrepareSend).toHaveBeenCalledWith('sp1sparkaddress', 1234, undefined)
  })
})

// The list opens on the asset the send will sign with, and follows a new choice.
test('the asset list marks the asset the send uses, then the one picked', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'ht',
    amount: 2_000_000,
    fee: 0,
    tokenIdentifier: USDB.identifier,
  })

  const tree = await render()
  await pasteDestination(tree, 'sp1sparkaddress')
  await pressBtn(tree, 'Asset')
  expect(markedInOpenPicker(tree.root)).toEqual([BITCOIN_ASSET_ID])

  await pickFromSheet(tree, USDB.identifier)
  await pressBtn(tree, 'Asset')
  expect(markedInOpenPicker(tree.root)).toEqual([USDB.identifier])
  await pickFromSheet(tree, USDB.identifier)
  await pressBtn(tree, 'Amount in USDB')
  await enterAmount(tree, 2)
  // The marked asset is the one the send was prepared with.
  expect(sparkPrepareSend).toHaveBeenCalledWith('sp1sparkaddress', 2_000_000n, USDB.identifier)
})

// The network list opens with nothing marked before a choice, and on the chosen network after one.
test('the network list marks the network the send uses, and none before a choice', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE, BASE_ROUTE],
  })

  const tree = await render()
  await pasteDestination(tree, '0xdeadbeef')
  expect(markedInOpenPicker(tree.root)).toEqual([])

  await pickFromSheet(tree, SOLANA_ROUTE.id)
  await pressBtn(tree, 'Destination network')
  expect(markedInOpenPicker(tree.root)).toEqual([SOLANA_ROUTE.id])

  await pickFromSheet(tree, BASE_ROUTE.id)
  await pressBtn(tree, 'Destination network')
  expect(markedInOpenPicker(tree.root)).toEqual([BASE_ROUTE.id])
})

test('a token review reads in the token unit, never in sats', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'ht',
    amount: 2_500_000,
    fee: 0,
    tokenIdentifier: USDB.identifier,
  })

  const tree = await render()
  await pasteDestination(tree, 'sp1sparkaddress')
  await pressBtn(tree, 'Asset')
  await pickFromSheet(tree, USDB.identifier)
  await pressBtn(tree, 'Amount in USDB')
  await enterAmount(tree, 2.5)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('2.5')
  expect(shown).toContain('USDB')
  expect(shown).not.toContain('2 500 000')
  expect(shown).not.toContain('sats')
})

test('a Spark invoice that names its own token pays in it, with no asset picker', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'sparkAddress',
    tokenIdentifier: USDB.identifier,
    amount: 1_000_000,
  })
  jest.mocked(sparkPrepareSend).mockResolvedValue({
    handle: 'hi',
    amount: 1_000_000,
    fee: 0,
    tokenIdentifier: USDB.identifier,
  })

  const tree = await render()
  await pasteDestination(tree, 'sparkinvoice1usdb')

  // The invoice decides the asset, since the SDK rejects paying it in anything else.
  expect(texts(tree)).not.toContain('Asset')
  expect(sparkPrepareSend).toHaveBeenCalledWith('sparkinvoice1usdb', undefined, USDB.identifier)
})

test('with no tokens held, a Spark address still asks for sats straight away', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
  const tree = await render()
  await pasteDestination(tree, 'sp1sparkaddress')

  await enterAmount(tree, 4200)

  expect(sparkPrepareSend).toHaveBeenCalledWith('sp1sparkaddress', 4200, undefined)
})

// A row's label replaces what it draws, so it has to carry the choice.
describe('the choice rows as a screen reader hears them', () => {
  const choiceLabels = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByType(Touch)
      .map(node => String(node.props.label ?? ''))
      .filter(label => label.includes(i18n.t('send.chooseAsset')) || label.includes(i18n.t('send.chooseRoute')))

  test('the asset row names the chosen asset before the action', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'spark1someone')

    expect(choiceLabels(tree)).toEqual([`${i18n.t('send.assetBitcoin')}, ${i18n.t('send.chooseAsset')}`])
  })

  // A picker row draws its mark at 20 and takes the shared row style, as Receive's does.
  test('the asset row is a picker row, with its mark at 20', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'spark1someone')

    const row = tree.root
      .findAllByType(Touch)
      .find(node => String(node.props.label ?? '').endsWith(i18n.t('send.chooseAsset')))!
    expect(row.props.style).toBe(receiveStyles.pickerRow)
    expect(row.findByType(AssetIcon).props.size).toBe(20)
  })

  test('the route row says the action once before a choice and names the route after it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'crossChainAddress',
      routes: [SOLANA_ROUTE, BASE_ROUTE],
    })
    const tree = await render()
    await pasteDestination(tree, 'SoLaNaAddr111')
    expect(choiceLabels(tree)).toEqual([i18n.t('send.chooseRoute')])

    await pickFromSheet(tree, SOLANA_ROUTE.id)
    expect(choiceLabels(tree)).toEqual([`USDC · Solana, ${i18n.t('send.chooseRoute')}`])
  })

  test('the route is worded by the locale, which can order the asset and the chain', async () => {
    const raw = i18n.getResource('en-US', 'translation', 'send.routeValue') as string
    i18n.addResource('en-US', 'translation', 'send.routeValue', '{{chain}} / {{asset}}')
    try {
      jest.mocked(sparkInspectDestination).mockResolvedValue({
        kind: 'crossChainAddress',
        routes: [SOLANA_ROUTE, BASE_ROUTE],
      })
      const tree = await render()
      await pasteDestination(tree, 'SoLaNaAddr111')
      await pickFromSheet(tree, SOLANA_ROUTE.id)
      expect(choiceLabels(tree)).toEqual([`Solana / USDC, ${i18n.t('send.chooseRoute')}`])
    } finally {
      i18n.addResource('en-US', 'translation', 'send.routeValue', raw)
    }
  })
})

// --- Cross-chain sends ---

test('a cross-chain address asks which chain and asset arrive before any amount', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE, BASE_ROUTE],
  })
  jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({
    handle: 'xc1',
    routeId: SOLANA_ROUTE.id,
    source: 'sats',
    amountIn: 50_000,
    feeSat: 120,
    estimatedOut: 49_500_000,
    feeAmount: 500_000,
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: '2099-08-06T12:00:00Z',
  })

  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')

  expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()

  await pickFromSheet(tree, SOLANA_ROUTE.id)
  await pressBtn(tree, 'Add amount')
  await enterAmount(tree, 50_000)

  expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(SOLANA_ROUTE.id, 50_000, 'sats')
  expect(sparkPrepareSend).not.toHaveBeenCalled()
})

test('the cross-chain review separates what leaves (sats) from what arrives (the asset)', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE],
  })
  jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({
    handle: 'xc1',
    routeId: SOLANA_ROUTE.id,
    source: 'sats',
    amountIn: 50_000,
    feeSat: 120,
    estimatedOut: 49_500_000,
    feeAmount: 500_000,
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: '2099-08-06T12:00:00Z',
  })

  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')
  await enterAmount(tree, 50_000)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Recipient gets')
  expect(shown).toMatch(/≈ 49\.5\s+USDC/) // estimatedOut, in the destination asset's units
  expect(shown).toContain('Solana')
  expect(shown).not.toContain('solana')
  expect(shown.replace(/\s/g, '')).toContain(formatSats(50_120).replace(/\s/g, ''))
})

test('a cross-chain address with no route says so instead of reviewing', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [] })

  const tree = await render()
  await pasteDestination(tree, '0xdeadbeef')

  expect(texts(tree).join(' ')).toContain('No network available for this address')
  expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
})

test('confirming a cross-chain send goes through the ordinary confirm', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE],
  })
  jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({
    handle: 'xc1',
    routeId: SOLANA_ROUTE.id,
    source: 'sats',
    amountIn: 50_000,
    feeSat: 120,
    estimatedOut: 49_500_000,
    feeAmount: 500_000,
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: '2099-08-06T12:00:00Z',
  })

  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')
  await enterAmount(tree, 50_000)
  await pressBtn(tree, 'Confirm send')

  expect(sparkConfirmSend).toHaveBeenCalledWith('xc1', undefined)
})

// Shaped after a live Orchestra entry for BTC to USDT on Tron, with a sats floor and a dollar band.
const TRON_ROUTE = {
  id: 'T-addr|tron|USDT|orchestra',
  chain: 'tron',
  asset: 'USDT',
  decimals: 6,
  provider: 'orchestra' as const,
  accepts: { btc: true, usdb: false },
  minSat: 1200,
  minUsdCents: 80,
  maxUsdCents: 8_980_000,
}

function crossChainError(tag: string, inner: object): Error {
  return Object.assign(new Error(`SdkError.${tag}`), { tag, inner })
}

// The keypad refuses an amount under the floor before it costs a quote, a wrong "no connection" and
// a retype.
test('the keypad carries the route bounds, the dollar floor included when a rate is known', async () => {
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 60_000 })
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [TRON_ROUTE] })

  const tree = await render()
  await pasteDestination(tree, 'TRonAddr111')

  // 0.80 USD at 60,000 USD/BTC is 1,334 sats, above the 1,200 sats floor.
  const sheet = tree.root.findByType(AmountSheet)
  expect(sheet.props.min).toBe(1334)
  expect(sheet.props.max).toBe(149_666_666)
  expect(sparkGetFiatRates).toHaveBeenCalledWith(expect.arrayContaining(['USD']))
})

test('without a dollar rate the keypad keeps the sats floor only', async () => {
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [TRON_ROUTE] })

  const tree = await render()
  await pasteDestination(tree, 'TRonAddr111')

  const sheet = tree.root.findByType(AmountSheet)
  expect(sheet.props.min).toBe(1200)
  expect(sheet.props.max).toBeUndefined()
})

test('a busy network says so, not that the phone is offline', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [TRON_ROUTE] })
  jest
    .mocked(sparkPrepareCrossChainSend)
    .mockRejectedValue(crossChainError('CrossChainRouteUnavailable', { reason: 'service_unavailable', temporary: true }))

  const tree = await render()
  await pasteDestination(tree, 'TRonAddr111')
  await enterAmount(tree, 5000)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('This network is busy')
  expect(shown).not.toContain('No connection')
  expect(shown).not.toContain('Could not review')
})

// Offering the refused network again would only repeat the refusal.
test('a network that refuses the send is dropped from the choice', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE, BASE_ROUTE],
  })
  jest
    .mocked(sparkPrepareCrossChainSend)
    .mockRejectedValue(crossChainError('CrossChainRouteUnavailable', { reason: 'route_disabled', temporary: false }))

  const tree = await render()
  await pasteDestination(tree, '0xdeadbeef')
  await pickFromSheet(tree, SOLANA_ROUTE.id)
  await pressBtn(tree, 'Add amount')
  await enterAmount(tree, 5000)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Choose another one')
  expect(shown).toContain('Choose destination network')
  type Item = { assetId: string }
  const routePicker = tree.root
    .findAllByType(AssetPickerSheet)
    .find(n => n.props.items.some((i: Item) => i.assetId === BASE_ROUTE.id))
  expect(routePicker?.props.items.map((i: Item) => i.assetId)).toEqual([BASE_ROUTE.id])
})

// Choosing again re-reads the destination, which lists the refused network among the others.
test('a refused network stays out when the destination is read again', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE, BASE_ROUTE],
  })
  jest
    .mocked(sparkPrepareCrossChainSend)
    .mockRejectedValueOnce(crossChainError('CrossChainRouteUnavailable', { reason: 'route_disabled', temporary: false }))
    .mockResolvedValue({
      handle: 'xc2',
      routeId: SOLANA_ROUTE.id,
      source: 'sats',
      amountIn: 5000,
      feeSat: 0,
      estimatedOut: 3_000_000,
      feeAmount: 0,
      chain: 'base',
      asset: 'USDC',
      decimals: 6,
      provider: 'orchestra',
      expiresAt: '2099-08-06T12:00:00Z',
    })

  const tree = await render()
  await pasteDestination(tree, '0xdeadbeef')
  await pickFromSheet(tree, SOLANA_ROUTE.id)
  await pressBtn(tree, 'Add amount')
  await enterAmount(tree, 5000)
  // A refusal leaves the choice closed; the network row opens it again.
  await pressBtn(tree, 'Choose destination network')
  await pickFromSheet(tree, BASE_ROUTE.id)
  await pressBtn(tree, 'Add amount')
  await enterAmount(tree, 5000)

  expect(sparkInspectDestination).toHaveBeenCalledTimes(3)
  type Item = { assetId: string }
  const routePicker = tree.root
    .findAllByType(AssetPickerSheet)
    .find(n => n.props.items.some((i: Item) => i.assetId === BASE_ROUTE.id))
  expect(routePicker?.props.items.map((i: Item) => i.assetId)).toEqual([BASE_ROUTE.id])
})

// "Choose another one" with nothing left to choose would lead to an empty list.
test('when the only network refuses, it says no network is available', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [SOLANA_ROUTE] })
  jest
    .mocked(sparkPrepareCrossChainSend)
    .mockRejectedValue(crossChainError('CrossChainRouteUnavailable', { reason: 'route_disabled', temporary: false }))

  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')
  await enterAmount(tree, 5000)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('No network available for this address')
  expect(shown).not.toContain('Choose another one')
})

// The network list names each chain and draws the coin's mark, never the SDK's slug in letters.
test('the network list reads as the coin on a named network', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [SOLANA_ROUTE] })

  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')

  const routePicker = tree.root
    .findAllByType(AssetPickerSheet)
    .find(n => n.props.items.some((i: { assetId: string }) => i.assetId === SOLANA_ROUTE.id))
  expect(routePicker?.props.items[0]).toMatchObject({ ticker: 'USDC', name: 'Solana', iconId: 'coin:USDC' })
})

// USDC on BSC has 18 decimals, past what a double holds exactly, so the raw figure prints noise.
test('an 18-decimal asset reads as a plain figure on the review', async () => {
  const BSC_ROUTE = { ...BASE_ROUTE, id: '0xabc|bsc|USDC|orchestra', chain: 'bsc', decimals: 18 }
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [BSC_ROUTE] })
  jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({
    handle: 'xc18',
    routeId: SOLANA_ROUTE.id,
    source: 'sats',
    amountIn: 40_000,
    feeSat: 0,
    estimatedOut: 24_850_000_000_000_000_000,
    feeAmount: 105_069_000_000_000_000,
    chain: 'bsc',
    asset: 'USDC',
    decimals: 18,
    provider: 'orchestra',
    expiresAt: '2026-09-24T12:00:00Z',
  })

  const tree = await render()
  await pasteDestination(tree, '0xabc')
  await enterAmount(tree, 40_000)

  const shown = texts(tree).join(' ')
  expect(shown).toContain('24.85 USDC')
  expect(shown).toContain('0.105069 USDC')
  expect(shown).not.toMatch(/24\.8500000/)
})

// --- State hygiene ---

test('a new destination drops the token chosen for the previous one', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })

  const tree = await render()
  await pasteDestination(tree, 'sp1firstaddress')
  await pressBtn(tree, 'Asset')
  await pickFromSheet(tree, USDB.identifier)

  // Carrying USDB over would send dollars to someone who was quoted in sats.
  jest.mocked(sparkPrepareSend).mockClear()
  await pasteDestination(tree, 'sp1secondaddress')
  await pressBtn(tree, 'Amount in USDB').catch(() => undefined)
  await enterAmount(tree, 3000)

  expect(sparkPrepareSend).toHaveBeenCalledWith('sp1secondaddress', 3000, undefined)
})

test('a new destination drops the cross-chain route chosen for the previous one', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({
    kind: 'crossChainAddress',
    routes: [SOLANA_ROUTE, BASE_ROUTE],
  })

  const tree = await render()
  await pasteDestination(tree, 'SoLaNaAddr111')
  await pickFromSheet(tree, SOLANA_ROUTE.id)

  // Reusing the old choice could prepare a send against the previous recipient's route.
  await pasteDestination(tree, 'SoLaNaAddr222')
  await enterAmount(tree, 10_000)

  expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
})

// The operator rejects the send once the swap outlives its price, so the screen says so rather than
// building a review nobody can act on.
test('the dollar wallet refuses an on-chain destination instead of quoting it', async () => {
  mockDollarMode = true
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  const tree = await render()

  await pasteDestination(tree, 'bc1qaddr')

  expect(texts(tree).join(' ')).toContain(
    "Sending to a bitcoin address doesn't work while the dollar wallet is on",
  )
  expect(sparkPrepareSend).not.toHaveBeenCalled()
})

test('the bitcoin wallet still quotes an on-chain destination', async () => {
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  const tree = await render()

  await pasteDestination(tree, 'bc1qaddr')
  await enterAmount(tree, 5000)

  expect(sparkPrepareSend).toHaveBeenCalled()
})

test('the asset picker titles bitcoin Bitcoin and names no rail', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
  const tree = await render()
  await pasteDestination(tree, 'sp1sparkaddress')

  const items = tree.root
    .findAllByType(AssetPickerSheet)
    .flatMap(sheet => sheet.props.items as { assetId: string; ticker: string; name: string }[])
  expect(items.find(item => item.assetId === BITCOIN_ASSET_ID)).toMatchObject({
    ticker: 'Bitcoin',
    name: '',
  })
})

describe('display currency', () => {
  // A device in Brazil, so the region default (BRL) and the saved choice differ. Rates put 2,000 sats
  // at R$ 11.00 and € 1.80, and only the coins asked for are answered, as sparkGetFiatRates does.
  const RATES: Record<string, number> = { USD: 100_000, BRL: 550_000, EUR: 90_000 }
  beforeEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  })
  afterEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    jest.mocked(sparkListFiatCurrencies).mockResolvedValue([])
  })

  // Read inside the keypad sheet, the line under the typed figure, so no other fiat line can answer.
  async function typedFiatLines(): Promise<string[]> {
    const tree = await render()
    await pasteDestination(tree, 'bc1qaddr')
    for (const key of '2000') {
      await pressBtn(tree, key)
    }
    return tree.root
      .findByType(AmountSheet)
      .findAllByType(Text)
      .map(node => node.props.children)
      .filter((child): child is string => typeof child === 'string' && child.startsWith('≈ '))
  }

  // A fresh process reaches Send before Home has loaded the SDK's currency list, so the screen has to
  // configure the formatter itself or a saved euro draws its bare code.
  test('a saved currency beyond BRL and USD shows its symbol under the typed amount', async () => {
    jest
      .mocked(sparkListFiatCurrencies)
      .mockResolvedValue([{ id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }])
    await saveDisplayCurrency('EUR')

    const lines = await typedFiatLines()

    expect(lines).toEqual(['≈ €1.80'])
  })

  test('with nothing saved the typed amount prices in the device region currency', async () => {
    const lines = await typedFiatLines()

    expect(lines).toEqual(['≈ R$11.00'])
  })
})

// What a person sees of NFC on this screen. The reading itself is in nfc.test.ts.
describe('reading a tag', () => {
  afterEach(() => {
    jest.mocked(nfcState).mockResolvedValue('unsupported')
  })

  // The newest handler Send gave AppState for an event, so a test can bring the app back to the
  // front. Jest's react-native preset already replaces addEventListener with a mock.
  function appStateHandler(type: string): (state?: string) => void {
    const call = jest
      .mocked(AppState.addEventListener)
      .mock.calls.filter(([event]) => event === type)
      .at(-1)
    if (!call) {
      throw new Error(`no AppState ${type} handler`)
    }
    return call[1] as (state?: string) => void
  }

  test('the chip stays hidden where the phone has no NFC', async () => {
    jest.mocked(nfcState).mockResolvedValue('unsupported')

    const tree = await render()

    expect(nfcState).toHaveBeenCalled()
    expect(texts(tree)).not.toContain(i18n.t('send.nfc'))
    expect(texts(tree)).not.toContain(i18n.t('send.nfcOff'))
  })

  test('with NFC switched off the chip says so, and a tap opens the setting instead of reading', async () => {
    jest.mocked(nfcState).mockResolvedValue('off')

    const tree = await render()
    expect(texts(tree)).toContain(i18n.t('send.nfcOff'))
    expect(texts(tree)).not.toContain(i18n.t('send.nfc'))
    await pressBtn(tree, i18n.t('send.nfcOff'))

    expect(openNfcSettings).toHaveBeenCalledTimes(1)
    expect(readNfcDestination).not.toHaveBeenCalled()
    expect(texts(tree)).not.toContain(i18n.t('send.nfcSettingsFailed'))
  })

  test('a setting that cannot be opened says so', async () => {
    jest.mocked(nfcState).mockResolvedValue('off')
    jest.mocked(openNfcSettings).mockResolvedValueOnce(false)

    const tree = await render()
    await pressBtn(tree, i18n.t('send.nfcOff'))

    expect(texts(tree)).toContain(i18n.t('send.nfcSettingsFailed'))
  })

  test('NFC switched on while Send is open shows the reading chip when the app comes back', async () => {
    jest.mocked(nfcState).mockResolvedValue('off')
    const original = Platform.OS
    Platform.OS = 'android'
    let tree: ReactTestRenderer.ReactTestRenderer
    try {
      tree = await render()
    } finally {
      Platform.OS = original
    }
    expect(texts(tree)).toContain(i18n.t('send.nfcOff'))

    jest.mocked(nfcState).mockResolvedValue('on')
    await ReactTestRenderer.act(async () => appStateHandler('change')('active'))
    await settle()
    expect(texts(tree)).toContain(i18n.t('send.nfc'))
    expect(texts(tree)).not.toContain(i18n.t('send.nfcOff'))

    // The quick settings drawn over the app hand focus back without leaving the app.
    jest.mocked(nfcState).mockResolvedValue('off')
    await ReactTestRenderer.act(async () => appStateHandler('focus')())
    await settle()
    expect(texts(tree)).toContain(i18n.t('send.nfcOff'))
  })

  test('leaving Send on Android removes both AppState subscriptions', async () => {
    const addEventListener = jest.mocked(AppState.addEventListener)
    addEventListener.mockClear()
    const original = Platform.OS
    Platform.OS = 'android'
    let tree: ReactTestRenderer.ReactTestRenderer
    try {
      tree = await render()
    } finally {
      Platform.OS = original
    }
    const subscriptions = addEventListener.mock.calls.map(([event], index) => ({
      event,
      remove: (addEventListener.mock.results[index].value as { remove: jest.Mock }).remove,
    }))
    expect(subscriptions.map(sub => sub.event).sort()).toEqual(['change', 'focus'])

    ReactTestRenderer.act(() => {
      tree.unmount()
    })
    mounted = null

    for (const sub of subscriptions) {
      expect(sub.remove).toHaveBeenCalledTimes(1)
    }
  })

  // The chip of a screen that NFC is on for, on the platform given.
  async function renderReady(os: 'android' | 'ios'): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(nfcState).mockResolvedValue('on')
    Platform.OS = os
    return render()
  }

  function waitingRead(): { answer: (result: NfcRead) => void; fail: (cause: Error) => void } {
    let answer!: (result: NfcRead) => void
    let fail!: (cause: Error) => void
    jest.mocked(readNfcDestination).mockImplementationOnce(
      () =>
        new Promise<NfcRead>((resolve, reject) => {
          answer = resolve
          fail = reject
        }),
    )
    return { answer: result => answer(result), fail: cause => fail(cause) }
  }

  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(NfcReadSheet).findByType(Sheet)

  describe('on Android', () => {
    const original = Platform.OS
    afterEach(() => {
      Platform.OS = original
      jest.mocked(readNfcDestination).mockReset()
      jest.mocked(cancelNfcRead).mockClear()
    })

    test('a press opens the sheet with the prompt before any tag arrives', async () => {
      waitingRead()
      const tree = await renderReady('android')
      expect(tree.root.findAllByType(Sheet).filter(s => s.props.visible)).toHaveLength(0)

      await pressBtn(tree, i18n.t('send.nfc'))

      expect(sheet(tree).props.visible).toBe(true)
      expect(texts(tree)).toContain(i18n.t('send.nfcPrompt'))
    })

    test('Cancel closes the sheet, ends the read and shows no error', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      await pressBtn(tree, i18n.t('common.cancel'))

      expect(cancelNfcRead).toHaveBeenCalledTimes(1)
      expect(sheet(tree).props.visible).toBe(false)
      await ReactTestRenderer.act(async () => read.answer({ kind: 'cancelled' }))
      expect(texts(tree)).not.toContain(i18n.t('send.nfcFailed'))
    })

    test('leaving the screen ends the read and shows no error', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      await ReactTestRenderer.act(async () => {
        for (const cleanup of mockFocusEffects.values()) {
          if (typeof cleanup === 'function') {
            cleanup()
          }
        }
      })

      expect(cancelNfcRead).toHaveBeenCalled()
      expect(sheet(tree).props.visible).toBe(false)
      await ReactTestRenderer.act(async () => read.fail(new Error('tag lost')))
      expect(texts(tree)).not.toContain(i18n.t('send.nfcFailed'))
    })

    test('unmounting ends the read', async () => {
      waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      ReactTestRenderer.act(() => tree.unmount())
      mounted = null

      expect(cancelNfcRead).toHaveBeenCalled()
    })

    test('an address that lands after a cancel fills nothing', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))
      await pressBtn(tree, i18n.t('common.cancel'))

      await ReactTestRenderer.act(async () => read.answer({ kind: 'address', value: 'lnbc1late' }))
      await settle()

      expect(tree.root.findByType(TextInput).props.value).toBe('')
      expect(sparkInspectDestination).not.toHaveBeenCalled()
    })

    test('a read refused as busy leaves the open sheet alone', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      jest.mocked(readNfcDestination).mockResolvedValueOnce({ kind: 'busy' })
      const chip = tree.root
        .findAll(node => typeof node.props.onPress === 'function')
        .find(node => node.findAll(n => n.props.children === i18n.t('send.nfc')).length > 0)
      await ReactTestRenderer.act(async () => chip?.props.onPress())

      expect(sheet(tree).props.visible).toBe(true)
      expect(texts(tree)).not.toContain(i18n.t('send.nfcFailed'))
      await ReactTestRenderer.act(async () => read.answer({ kind: 'cancelled' }))
    })

    test('a tag with no address says so in the sheet, and it is no failure', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      await ReactTestRenderer.act(async () => read.answer({ kind: 'noAddress' }))

      expect(sheet(tree).props.visible).toBe(true)
      expect(texts(tree)).toContain(i18n.t('send.nfcNoAddress'))
      expect(texts(tree)).not.toContain(i18n.t('send.nfcPrompt'))
      expect(texts(tree)).not.toContain(i18n.t('send.nfcFailed'))
      await pressBtn(tree, i18n.t('common.close'))
      expect(sheet(tree).props.visible).toBe(false)
    })

    test('a read that fails closes the sheet and shows the failure', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      await ReactTestRenderer.act(async () => read.fail(new Error('You can only issue one request')))

      expect(sheet(tree).props.visible).toBe(false)
      expect(texts(tree)).toContain(i18n.t('send.nfcFailed'))
    })

    test('an address read fills the destination and prepares it', async () => {
      const read = waitingRead()
      const tree = await renderReady('android')
      await pressBtn(tree, i18n.t('send.nfc'))

      await ReactTestRenderer.act(async () =>
        read.answer({ kind: 'address', value: 'lnbc1fromthetag' }),
      )
      await settle()

      expect(sheet(tree).props.visible).toBe(false)
      expect(sparkInspectDestination).toHaveBeenCalledWith('lnbc1fromthetag')
    })
  })

  describe('on iOS', () => {
    const original = Platform.OS
    afterEach(() => {
      Platform.OS = original
      jest.mocked(readNfcDestination).mockReset()
    })

    test('no sheet of ours opens', async () => {
      const read = waitingRead()
      const tree = await renderReady('ios')

      await pressBtn(tree, i18n.t('send.nfc'))

      expect(readNfcDestination).toHaveBeenCalledWith(i18n.t('send.nfcPrompt'))
      expect(sheet(tree).props.visible).toBe(false)
      await ReactTestRenderer.act(async () => read.answer({ kind: 'noAddress' }))
      expect(sheet(tree).props.visible).toBe(false)
      expect(texts(tree)).not.toContain(i18n.t('send.nfcNoAddress'))
    })

    test('an address read fills the destination as on Android', async () => {
      const read = waitingRead()
      const tree = await renderReady('ios')
      await pressBtn(tree, i18n.t('send.nfc'))

      await ReactTestRenderer.act(async () =>
        read.answer({ kind: 'address', value: 'lnbc1fromthetag' }),
      )
      await settle()

      expect(sparkInspectDestination).toHaveBeenCalledWith('lnbc1fromthetag')
    })
  })

  test('on iOS Send never asks AppState for focus, an event only Android has', async () => {
    jest.mocked(AppState.addEventListener).mockClear()
    const original = Platform.OS
    Platform.OS = 'ios'
    try {
      await render()
    } finally {
      Platform.OS = original
    }

    const events = jest.mocked(AppState.addEventListener).mock.calls.map(([event]) => event)
    expect(events).toContain('change')
    expect(events).not.toContain('focus')
  })

  // A blur runs each focus effect's cleanup and the focus that follows runs the effect again.
  async function focusAgain(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      for (const [callback, cleanup] of [...mockFocusEffects]) {
        if (typeof cleanup === 'function') {
          cleanup()
        }
        mockFocusEffects.set(callback, callback())
      }
    })
    await settle()
  }

  test('NFC switched on in the settings shows the reading chip when Send is focused again', async () => {
    jest.mocked(nfcState).mockResolvedValue('off')
    const tree = await render()
    expect(texts(tree)).toContain(i18n.t('send.nfcOff'))
    const asked = jest.mocked(nfcState).mock.calls.length

    jest.mocked(nfcState).mockResolvedValue('on')
    await focusAgain()
    expect(nfcState).toHaveBeenCalledTimes(asked + 1)
    expect(texts(tree)).toContain(i18n.t('send.nfc'))
    expect(texts(tree)).not.toContain(i18n.t('send.nfcOff'))
  })

  test('only the newest check lands, and the chip keeps the last answer while one is in flight', async () => {
    jest.mocked(nfcState).mockResolvedValue('off')
    const tree = await render()

    let slow!: (state: 'on' | 'off') => void
    jest.mocked(nfcState).mockImplementationOnce(() => new Promise(resolve => (slow = resolve)))
    await ReactTestRenderer.act(async () => appStateHandler('change')('active'))
    expect(texts(tree)).toContain(i18n.t('send.nfcOff'))

    jest.mocked(nfcState).mockResolvedValueOnce('on')
    await ReactTestRenderer.act(async () => appStateHandler('change')('active'))
    await settle()
    expect(texts(tree)).toContain(i18n.t('send.nfc'))

    await ReactTestRenderer.act(async () => slow('off'))
    await settle()
    expect(texts(tree)).toContain(i18n.t('send.nfc'))
  })

  test('the chip hands the sheet its line in the app language, and a cancel shows nothing', async () => {
    jest.mocked(nfcState).mockResolvedValue('on')
    jest.mocked(readNfcDestination).mockResolvedValue({ kind: 'cancelled' })

    const tree = await render()
    expect(texts(tree)).toContain(i18n.t('send.nfc'))
    await pressBtn(tree, i18n.t('send.nfc'))

    expect(readNfcDestination).toHaveBeenCalledWith(i18n.t('send.nfcPrompt'))
    expect(i18n.t('send.nfcPrompt')).not.toBe('send.nfcPrompt')
    expect(texts(tree)).not.toContain(i18n.t('send.nfcFailed'))
    expect(openNfcSettings).not.toHaveBeenCalled()
    expect(sparkInspectDestination).not.toHaveBeenCalled()
  })

  // A chip is a third of the row, so a long label shrinks on one line inside the border instead of
  // running to its edge, as Contacts does in Arabic.
  test('every chip label fits its chip on one line, shrinking when it must', async () => {
    jest.mocked(nfcState).mockResolvedValue('on')
    const tree = await render()
    const words = [i18n.t('send.paste'), i18n.t('send.scan'), i18n.t('send.contacts'), i18n.t('send.nfc')]
    const labels = tree.root.findAllByType(Text).filter(node => words.includes(node.props.children))
    expect(labels).toHaveLength(4)
    for (const label of labels) {
      const style = Object.assign({}, ...[label.props.style].flat(Infinity).filter(x => x && typeof x === 'object'))
      expect([label.props.numberOfLines, label.props.adjustsFontSizeToFit, style.flexShrink]).toEqual([1, true, 1])
    }
  })

  // Four flex chips leave each label about 72dp on a 360dp phone, so the NFC chip takes its own row.
  test('the NFC chip sits on its own row, leaving the three chips their width', async () => {
    jest.mocked(nfcState).mockResolvedValue('on')

    const tree = await render()
    const chipRow = tree.root
      .findAllByType(Row)
      .find(row => row.findAllByType(Text).some(txt => txt.props.children === i18n.t('send.paste')))
    const labels = chipRow!.findAllByType(Text).map(txt => txt.props.children)

    expect(labels).toEqual([i18n.t('send.paste'), i18n.t('send.scan'), i18n.t('send.contacts')])
    expect(texts(tree)).toContain(i18n.t('send.nfc'))
  })
})

// iOS aligns a TextInput's text by the app bundle's localization rather than by the layout, so the
// destination takes the leading edge of the running direction (UI-65). Jest resolves react-native
// for iOS; Android aligns by the layout, which direction.test.ts holds for leadingInput itself.
describe('the destination field under each direction', () => {
  const destinationAlign = (tree: ReactTestRenderer.ReactTestRenderer) =>
    StyleSheet.flatten(
      tree.root.findAllByType(TextInput).find(node => node.props.placeholder === i18n.t('send.destinationPlaceholder'))!
        .props.style,
    )?.textAlign

  test.each([
    [true, 'right'],
    [false, 'left'],
  ])('with RTL %s the value and the placeholder sit on the %s', async (rtl, edge) => {
    const running = jest.replaceProperty(I18nManager, 'isRTL', rtl)
    try {
      expect(destinationAlign(await render())).toBe(edge)
    } finally {
      running.restore()
    }
  })
})

describe('a dollar wallet paying another chain', () => {
  const USDB_ROUTE: SparkCrossChainRoute = {
    ...BASE_ROUTE,
    id: '0xabc|base|USDT|orchestra',
    asset: 'USDT',
    accepts: { btc: true, usdb: true },
    minSat: 1_200,
    usdbMin: 2,
    usdbMax: 1_000,
  }
  const OFFERED = [USDB_ROUTE, SOLANA_ROUTE]
  const usdb = (balanceBaseUnits: number): SparkWalletInfo['tokens'][number] =>
    ({ identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits } as SparkWalletInfo['tokens'][number])
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AmountSheet)
  const quoted = (over: Partial<SparkCrossChainQuote> = {}): SparkCrossChainQuote => ({
    handle: 'xd1',
    routeId: USDB_ROUTE.id,
    source: 'usdb',
    amountIn: 1_020_000,
    feeSat: 0,
    estimatedOut: 1_000_000,
    feeAmount: 20_000,
    chain: 'base',
    asset: 'USDT',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: '2099-08-06T12:00:00Z',
    ...over,
  })
  const CONVERSION = { tokenIdentifier: USDB.identifier, amountIn: 1_100_000, amountOut: 1_210, fee: 5_000 }
  const wallet = (balanceSat: number, token: number): SparkWalletInfo => ({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat,
    tokens: token > 0 ? [usdb(token)] : [],
  })
  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s/g, ' ')
  const confirm = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(GradientButton)

  beforeEach(() => {
    mockDollarMode = true
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(0, 50_000_000))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: OFFERED })
    jest.mocked(sparkPrepareCrossChainSend).mockReset()
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(quoted())
  })

  afterEach(() => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
  })

  async function toSheet(route: SparkCrossChainRoute = USDB_ROUTE): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await pasteDestination(tree, '0xabc')
    await pickFromSheet(tree, route.id)
    await pressBtn(tree, 'Add amount')
    return tree
  }

  async function toReview(
    quote: SparkCrossChainQuote = quoted(),
    route: SparkCrossChainRoute = USDB_ROUTE,
    typed = 1,
  ): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await toSheet(route)
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(quote)
    await enterAmount(tree, typed)
    return tree
  }

  describe('the sheet', () => {
    test('a route that takes USDB types dollars, and the SDK is asked in USDB', async () => {
      const tree = await toSheet()

      expect(sheet(tree).props).toMatchObject({ dollars: true, satsBtcToggle: false, maxDecimals: 2 })
      await enterAmount(tree, 12.5)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 12_500_000, 'usdb')
    })

    test('the figure drawn is the one the SDK is asked for, to the cent', async () => {
      const tree = await toSheet()

      for (const key of '12.49') {
        await pressBtn(tree, key)
      }

      expect(texts(tree)).toContain('12.49')
      await pressBtn(tree, i18n.t('receive.confirmAmount'))
      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 12_490_000, 'usdb')
    })

    test('with no rate at all it still types dollars, since USDB needs none', async () => {
      jest.mocked(sparkGetFiatRates).mockRejectedValue(new Error('offline'))
      const tree = await toSheet()

      await enterAmount(tree, 3)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 3_000_000, 'usdb')
    })

    test('a route that takes only sats opens in dollars at the rate, and the SDK is asked in sats', async () => {
      const tree = await toSheet(SOLANA_ROUTE)

      expect(sheet(tree).props).toMatchObject({ dollars: false, satsBtcToggle: true, initialDenom: 'fiat', fiatCurrency: 'USD' })
      await enterAmount(tree, 40_000)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(SOLANA_ROUTE.id, 40_000, 'sats')
    })

    test('with the mode off the same route stays in sats', async () => {
      mockDollarMode = false
      const tree = await toSheet()

      expect(sheet(tree).props).toMatchObject({ dollars: false, satsBtcToggle: true })
      await enterAmount(tree, 40_000)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 40_000, 'sats')
    })

    test('USDB is bound by its own limits, and sats by theirs', async () => {
      const tree = await toSheet()
      expect(sheet(tree).props).toMatchObject({ min: 2, max: 1_000 })

      const bounded = { ...SOLANA_ROUTE, minSat: 1_500, maxSat: 90_000 }
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [USDB_ROUTE, bounded] })
      const other = await toSheet(bounded)
      expect(sheet(other).props).toMatchObject({ min: 1_500, max: 90_000 })
    })

    test('the available line counts the USDB alone, since the sats do not fund this send', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(50_000, 50_000_000))
      const tree = await toSheet()

      expect(sheet(tree).props.availableNote).toBe('≈ $50.00')
      expect(sheet(tree).props.onUseAll).toBeUndefined()
    })

    // A balance is a ceiling: 1.235 USDB reads $1.23, so the figure drawn is never more than is held.
    test('the available line cuts the dollars, never rounding them up', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(50_000, 1_235_000))
      const tree = await toSheet()

      expect(sheet(tree).props.availableNote).toBe('≈ $1.23')
    })

    test('the mode turning off with the sheet up changes no unit of what it hands back', async () => {
      const tree = await toSheet()
      mockDollarMode = false
      await ReactTestRenderer.act(async () => tree.update(<SendSpark />))

      await enterAmount(tree, 12.5)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 12_500_000, 'usdb')
    })
  })

  describe('the review', () => {
    test('opens on what arrives, then what leaves in USDB, never in sats', async () => {
      const tree = await toReview()

      const shown = flat(tree)
      expect(shown).toContain('Recipient gets')
      expect(shown).toMatch(/≈ 1\s+USDT/)
      expect(shown).toContain('Leaves your wallet')
      expect(shown).toContain('1.02 USDB')
      expect(shown).not.toContain('sats')
      expect(shown.indexOf('Recipient gets')).toBeLessThan(shown.indexOf('Leaves your wallet'))
    })

    test('the mode off keeps the sats that leave in sight', async () => {
      mockDollarMode = false
      const tree = await toReview(quoted({ source: 'sats', amountIn: 50_000 }))

      const shown = flat(tree)
      expect(shown).toContain('Leaves your wallet')
      expect(shown).toContain(`${formatSats(50_000).replace(/\s/g, ' ')} sats`)
      expect(shown).not.toContain('USDB')
    })

    test('a sats source on a dollar wallet reads its dollars beside the sats', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(90_000, 0))
      const tree = await toReview(quoted({ source: 'sats', amountIn: 50_000, routeId: SOLANA_ROUTE.id }), SOLANA_ROUTE)

      const shown = flat(tree)
      expect(shown).toContain(`${formatSats(50_000).replace(/\s/g, ' ')} sats`)
      expect(shown).toContain('≈ $50.00')
    })

    test('a quote stays in its own unit when the mode turns off under it', async () => {
      const tree = await toReview()
      mockDollarMode = false
      await ReactTestRenderer.act(async () => tree.update(<SendSpark />))

      expect(flat(tree)).toContain('1.02 USDB')
      expect(flat(tree)).not.toContain('sats')
    })

    test('the fee reads in what arrives, and sats only when there are any', async () => {
      const tree = await toReview(quoted({ feeAmount: 20_000, feeSat: 0 }))
      expect(flat(tree)).toContain('0.02 USDT')
      expect(flat(tree)).not.toContain('sats')

      const other = await toReview(quoted({ feeSat: 35 }))
      expect(flat(other)).toContain('35 sats')
    })

    test('with no conversion from the SDK there is no Converts line', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(90_000, 50_000_000))
      const tree = await toReview(quoted({ source: 'sats', amountIn: 50_000, routeId: SOLANA_ROUTE.id }), SOLANA_ROUTE)

      expect(flat(tree)).not.toContain('Converts')
      expect(flat(tree)).toContain('Leaves your wallet')
    })

    test('with a conversion the token is what leaves, and no sats are claimed as the wallet\'s', async () => {
      const tree = await toReview(
        quoted({ source: 'sats', amountIn: 1_200, routeId: SOLANA_ROUTE.id, conversion: CONVERSION }),
        SOLANA_ROUTE,
      )

      expect(flat(tree)).toContain('Converts')
      expect(flat(tree)).toContain('1.1 USDB')
      expect(flat(tree)).not.toContain('Leaves your wallet')
    })

    test('the network and the asset show with nothing having been chosen by hand', async () => {
      const tree = await toReview()

      expect(flat(tree)).toContain('Base')
      expect(flat(tree)).toMatch(/USDT/)
    })
  })

  describe('the balance a quote is weighed against', () => {
    test('no sats and enough USDB leaves Confirm on', async () => {
      const tree = await toReview()

      expect(flat(tree)).not.toContain('Not enough balance')
      expect(confirm(tree).props.disabled).toBeFalsy()
    })

    test('USDB short of amountIn refuses, whatever the sats', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(90_000_000, 1_010_000))
      const tree = await toReview()

      expect(flat(tree)).toContain('Not enough balance')
      expect(confirm(tree).props.disabled).toBe(true)
    })

    test('a conversion weighs its amountIn against the token, not its sats against the sats', async () => {
      const conversion = quoted({ source: 'sats', amountIn: 1_200, routeId: SOLANA_ROUTE.id, conversion: CONVERSION })
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(0, 1_100_000))
      const enough = await toReview(conversion, SOLANA_ROUTE)
      expect(flat(enough)).not.toContain('Not enough balance')

      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(90_000, 1_099_999))
      const short = await toReview(conversion, SOLANA_ROUTE)
      expect(flat(short)).toContain('Not enough balance')
    })

    test('a sats source with no conversion weighs the sats', async () => {
      mockDollarMode = false
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(49_999, 90_000_000))
      const tree = await toReview(quoted({ source: 'sats', amountIn: 50_000 }))

      expect(flat(tree)).toContain('Not enough balance')
    })

    test('a balance still waiting for its sync refuses nothing, and the SDK decides', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ ...wallet(0, 0), sync: 'waiting' })
      const tree = await toReview()

      expect(flat(tree)).not.toContain('Not enough balance')
    })
  })

  describe('after Confirm', () => {
    const overlay = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(ReceivedOverlay).props

    test('USDB reads as USDB, and it is on its way rather than sent', async () => {
      const tree = await toReview()

      await pressBtn(tree, 'Confirm send')

      expect(overlay(tree).amount).toMatchObject({ value: 1.02, unit: 'USDB' })
      expect(overlay(tree).amount.format(1.02)).toBe('1.02')
      expect(overlay(tree).label).toBe(i18n.t('send.onTheWay'))
    })

    // The wallet's record ends with the Spark side, so only History follows the delivery, whatever
    // the SDK said of that side.
    test.each(['pending', 'complete'] as const)(
      'a send the SDK calls %s points at History for its delivery',
      async status => {
        jest.mocked(sparkConfirmSend).mockResolvedValue(status)
        const tree = await toReview()

        await pressBtn(tree, 'Confirm send')

        expect(overlay(tree).label).toBe(i18n.t('send.onTheWay'))
        expect(overlay(tree).pending).toBe(i18n.t('send.pendingDelivery'))
      },
    )

    test('the review calls its fee a delivery fee, never the network fee', async () => {
      const tree = await toReview()

      expect(texts(tree)).toContain(i18n.t('send.deliveryFee'))
      expect(texts(tree)).not.toContain(i18n.t('send.fee'))
      expect(flat(tree)).not.toContain('Network fee')
    })

    test('a sats source is on its way too, in dollars on a dollar wallet', async () => {
      const tree = await toReview(quoted({ source: 'sats', amountIn: 50_000, routeId: SOLANA_ROUTE.id }), SOLANA_ROUTE)

      await pressBtn(tree, 'Confirm send')

      expect(overlay(tree).amount.value).toBe(50)
      expect(overlay(tree).label).toBe(i18n.t('send.onTheWay'))
    })

    test('the step line names the conversion the SDK runs first', async () => {
      let answer: (status: 'pending') => void = () => undefined
      jest.mocked(sparkConfirmSend).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      const tree = await toReview(
        quoted({ source: 'sats', amountIn: 1_200, routeId: SOLANA_ROUTE.id, conversion: CONVERSION }),
        SOLANA_ROUTE,
      )

      await pressBtn(tree, 'Confirm send')

      expect(flat(tree)).toContain(i18n.t('send.stageConverting'))
      await ReactTestRenderer.act(async () => answer('pending'))
      await settle()
    })

    // A token leg has no idempotency: a second send could pay twice.
    test('a failed confirm with a token leg never sends again', async () => {
      jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('network'))
      const tree = await toReview()

      await pressBtn(tree, 'Confirm send')

      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
      expect(flat(tree)).toContain(i18n.t('send.checkHistory'))
      expect(flat(tree)).not.toContain('Confirm send')
    })

    test('an expired quote is prepared again from the same source and amount, and sent by a press', async () => {
      const expired = Object.assign(new Error('SdkError.Generic'), {
        tag: 'Generic',
        inner: ['Cross-chain quote has expired. Please re-prepare.'],
      })
      jest.mocked(sparkConfirmSend).mockRejectedValueOnce(expired)
      const tree = await toReview(quoted(), USDB_ROUTE, 12.5)
      jest.mocked(sparkPrepareCrossChainSend).mockClear()
      jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(quoted({ handle: 'xd2' }))

      await pressBtn(tree, 'Confirm send')

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 12_500_000, 'usdb')
      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    })

    test('a refresh that fails offers a retry in the same source', async () => {
      const expired = Object.assign(new Error('SdkError.Generic'), {
        tag: 'Generic',
        inner: ['Cross-chain quote has expired. Please re-prepare.'],
      })
      jest.mocked(sparkConfirmSend).mockRejectedValueOnce(expired)
      const tree = await toReview(quoted(), USDB_ROUTE, 12.5)
      jest.mocked(sparkPrepareCrossChainSend).mockRejectedValueOnce(new Error('network'))
      await pressBtn(tree, 'Confirm send')

      jest.mocked(sparkPrepareCrossChainSend).mockClear()
      jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(quoted({ handle: 'xd3' }))
      await pressBtn(tree, i18n.t('common.retry'))

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDB_ROUTE.id, 12_500_000, 'usdb')
    })
  })
})

describe('network and provider', () => {
  const USDT_TRON = { ...SOLANA_ROUTE, id: 'a|tron|USDT|orchestra', chain: 'tron', asset: 'USDT' }
  const USDT_BASE = { ...SOLANA_ROUTE, id: 'a|base|USDT|orchestra', chain: 'base', asset: 'USDT' }
  const USDC_BASE = { ...SOLANA_ROUTE, id: 'a|base|USDC|orchestra', chain: 'base', asset: 'USDC' }
  const BOLTZ_BASE: SparkCrossChainRoute = { ...USDT_BASE, id: 'a|base|USDT|boltz', provider: 'boltz' }
  const offer = (over: Partial<SparkCrossChainQuote> = {}): SparkCrossChainQuote => ({
    handle: 'orc',
    routeId: USDT_BASE.id,
    source: 'sats',
    amountIn: 50_000,
    feeSat: 0,
    estimatedOut: 49_000_000,
    feeAmount: 1_000_000,
    chain: 'base',
    asset: 'USDT',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: '2099-08-06T12:00:00Z',
    ...over,
  })
  const OFFER_BOLTZ = offer({
    handle: 'bol',
    routeId: BOLTZ_BASE.id,
    provider: 'boltz',
    estimatedOut: 49_400_000,
    feeAmount: 600_000,
  })
  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s/g, ' ')
  const routePicker = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(AssetPickerSheet).find(node => node.props.title === i18n.t('send.chooseRoute'))!
  const refused = (temporary: boolean) =>
    Object.assign(new Error('SdkError.CrossChainRouteUnavailable'), {
      tag: 'CrossChainRouteUnavailable',
      inner: { reason: 'route_disabled', temporary },
    })

  beforeEach(() => {
    jest.mocked(sparkPrepareCrossChainSend).mockReset()
    jest.mocked(sparkPrepareCrossChainSend).mockImplementation(async id => (id === BOLTZ_BASE.id ? OFFER_BOLTZ : offer()))
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'crossChainAddress',
      routes: [USDT_BASE, BOLTZ_BASE],
    })
  })

  describe('choosing the network', () => {
    test('one network decides alone and goes on to the amount', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [USDT_TRON] })
      const tree = await render()

      await pasteDestination(tree, 'TAddr')

      expect(routePicker(tree).props.visible).toBe(false)
      expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
      expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
    })

    test('two networks open the list and choose nothing', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [USDT_BASE, USDT_TRON] })
      const tree = await render()

      await pasteDestination(tree, '0xabc')

      expect(routePicker(tree).props.visible).toBe(true)
      expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)
    })

    test('two providers of one network are one choice, so it decides alone', async () => {
      const tree = await render()

      await pasteDestination(tree, '0xabc')

      expect(routePicker(tree).props.visible).toBe(false)
      expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
    })

    test('two contracts of one asset on one network are asked, each line naming its own', async () => {
      const usdcOne = { ...USDC_BASE, id: '0xabc|base|USDC|0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913|0', contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }
      const usdcTwo = { ...USDC_BASE, id: '0xabc|base|USDC|0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA|0', contractAddress: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' }
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [usdcOne, usdcTwo] })
      const tree = await render()

      await pasteDestination(tree, '0xabc')

      expect(routePicker(tree).props.visible).toBe(true)
      expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)
      const items = routePicker(tree).props.items as PickerItem[]
      expect(items.map(item => item.subtitle)).toEqual(['0x833589…A02913', '0xd9aAEc…10b6CA'])

      await pickFromSheet(tree, usdcTwo.id)
      await pressBtn(tree, 'Add amount')
      await enterAmount(tree, 50_000)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(usdcTwo.id, 50_000, 'sats')
    })

    test('the list has a line per network, in order, with no provider on it', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({
        kind: 'crossChainAddress',
        routes: [USDC_BASE, USDT_BASE, BOLTZ_BASE, USDT_TRON],
      })
      const tree = await render()

      await pasteDestination(tree, '0xabc')

      const items = routePicker(tree).props.items as PickerItem[]
      expect(items.map(item => `${item.ticker} ${item.name}`)).toEqual(['USDT Tron', 'USDT Base', 'USDC Base'])
      expect(items.every(item => item.subtitle === undefined)).toBe(true)
    })

    test('the line chosen stays marked whichever provider the review ends on', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({
        kind: 'crossChainAddress',
        routes: [USDT_BASE, BOLTZ_BASE, USDT_TRON],
      })
      const tree = await render()
      await pasteDestination(tree, '0xabc')
      await pickFromSheet(tree, USDT_BASE.id)
      await pressBtn(tree, 'Add amount')
      await enterAmount(tree, 50_000)

      expect(routePicker(tree).props.selectedId).toBe(USDT_BASE.id)
    })

    // Choosing on the person's behalf here would pay on a network nobody looked at.
    test('after a refusal one network left is not chosen alone', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [USDT_BASE, USDT_TRON] })
      jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(refused(false))
      const tree = await render()
      await pasteDestination(tree, '0xabc')
      await pickFromSheet(tree, USDT_BASE.id)
      await pressBtn(tree, 'Add amount')
      await enterAmount(tree, 50_000)
      expect(flat(tree)).toContain(i18n.t('errors.routeUnavailable'))
      jest.mocked(sparkPrepareCrossChainSend).mockClear()

      await enterAmount(tree, 50_000)

      expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
      expect(routePicker(tree).props.visible).toBe(true)
      expect((routePicker(tree).props.items as PickerItem[]).map(item => item.assetId)).toEqual([USDT_TRON.id])
    })

    test('a refusal that is only temporary keeps the network on the list', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [USDT_BASE, USDT_TRON] })
      jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(refused(true))
      const tree = await render()
      await pasteDestination(tree, '0xabc')
      await pickFromSheet(tree, USDT_BASE.id)
      await pressBtn(tree, 'Add amount')

      await enterAmount(tree, 50_000)

      expect((routePicker(tree).props.items as PickerItem[]).map(item => item.assetId)).toContain(USDT_BASE.id)
      expect(routePicker(tree).props.selectedId).toBe(USDT_BASE.id)
    })
  })

  describe('two providers on one network', () => {
    async function toReview(): Promise<ReactTestRenderer.ReactTestRenderer> {
      const tree = await render()
      await pasteDestination(tree, '0xabc')
      await enterAmount(tree, 50_000)
      return tree
    }

    test('both quote once the amount is in, and who delivers more is marked', async () => {
      const tree = await toReview()

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(2)
      const marked = tree.root.findAllByType(Touch).filter(node => node.props.state?.selected === true)
      expect(marked).toHaveLength(1)
      expect(marked[0].findAllByType(Text).map(node => node.props.children)).toContain('Boltz')
      expect(flat(tree)).toContain('≈ 49 USDT')
      expect(flat(tree)).toContain('≈ 49.4 USDT')
    })

    test('Confirm sends the marked offer, and the other is dropped', async () => {
      const tree = await toReview()

      await pressBtn(tree, 'Confirm send')

      expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
      expect(jest.mocked(sparkConfirmSend).mock.calls[0][0]).toBe('bol')
      expect(sparkDiscardSendQuote).toHaveBeenCalledTimes(1)
      expect(sparkDiscardSendQuote).toHaveBeenCalledWith('orc')
    })

    test('a line pressed moves the mark, and Confirm follows it', async () => {
      const tree = await toReview()

      await pressBtn(tree, 'Orchestra')
      expect(flat(tree)).toMatch(/≈ 49\s+USDT/)
      await pressBtn(tree, 'Confirm send')

      expect(jest.mocked(sparkConfirmSend).mock.calls[0][0]).toBe('orc')
      expect(sparkDiscardSendQuote).toHaveBeenCalledWith('bol')
    })

    test('leaving the review drops every offer', async () => {
      const tree = await toReview()

      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
      mockRouteParams = { destination: 'lnbc1other', picked: 1 }
      await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
      await settle()

      expect(jest.mocked(sparkDiscardSendQuote).mock.calls.map(call => call[0]).sort()).toEqual(['bol', 'orc'])
    })

    test('a USDB amount is never quoted on a provider that takes only sats', async () => {
      mockDollarMode = true
      const usdb = { ...USDT_BASE, accepts: { btc: true, usdb: true } }
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [usdb, BOLTZ_BASE] })
      const tree = await render()
      await pasteDestination(tree, '0xabc')

      await enterAmount(tree, 12)

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(USDT_BASE.id, 12_000_000, 'usdb')
    })

    test('a provider that fails goes quietly, and the other stands alone', async () => {
      jest.mocked(sparkPrepareCrossChainSend).mockImplementation(async id => {
        if (id === BOLTZ_BASE.id) {
          throw new Error('network')
        }
        return offer()
      })
      const tree = await toReview()

      expect(flat(tree)).toMatch(/≈ 49\s+USDT/)
      expect(flat(tree)).not.toContain(i18n.t('send.deliveredBy'))
      expect(flat(tree)).not.toContain('Boltz')
      expect(flat(tree)).not.toContain(i18n.t('errors.offline'))
    })

    test('with the one answer on the other route, the send follows that route', async () => {
      jest.mocked(sparkPrepareCrossChainSend).mockImplementation(async id => {
        if (id === USDT_BASE.id) {
          throw new Error('network')
        }
        return OFFER_BOLTZ
      })
      const tree = await toReview()

      await pressBtn(tree, 'Confirm send')

      expect(jest.mocked(sparkConfirmSend).mock.calls[0][0]).toBe('bol')
    })

    test('all failing is the failure of a single quote', async () => {
      jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(new Error('Network request failed'))
      const tree = await toReview()

      expect(flat(tree)).toContain(i18n.t('errors.offline'))
      expect(flat(tree)).not.toContain('Confirm send')
    })

    test('the first answer waits for the second behind the skeleton', async () => {
      let answer: (q: SparkCrossChainQuote) => void = () => undefined
      jest.mocked(sparkPrepareCrossChainSend).mockImplementation(id =>
        id === BOLTZ_BASE.id ? new Promise(resolve => (answer = resolve)) : Promise.resolve(offer()),
      )
      const tree = await toReview()
      expect(flat(tree)).not.toContain('Confirm send')

      await ReactTestRenderer.act(async () => answer(OFFER_BOLTZ))
      await settle()

      expect(flat(tree)).toContain('Confirm send')
    })

    test('past the limit whoever answered stands, and a late answer holds nothing', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
      try {
        let answer: (q: SparkCrossChainQuote) => void = () => undefined
        jest.mocked(sparkPrepareCrossChainSend).mockImplementation(id =>
          id === BOLTZ_BASE.id ? new Promise(resolve => (answer = resolve)) : Promise.resolve(offer()),
        )
        const tree = await toReview()

        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(15_000)
        })
        await settle()
        expect(flat(tree)).toContain('Confirm send')
        expect(flat(tree)).not.toContain('Boltz')

        await ReactTestRenderer.act(async () => answer(OFFER_BOLTZ))
        await settle()
        expect(sparkDiscardSendQuote).toHaveBeenCalledWith('bol')
        expect(flat(tree)).not.toContain('Boltz')
      } finally {
        jest.useRealTimers()
      }
    })

    test('a destination replaced with both in flight drops their answers', async () => {
      const answers: Array<(q: SparkCrossChainQuote) => void> = []
      jest.mocked(sparkPrepareCrossChainSend).mockImplementation(() => new Promise(resolve => answers.push(resolve)))
      const tree = await toReview()

      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
      mockRouteParams = { destination: 'lnbc1other', picked: 1 }
      await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
      await settle()
      await ReactTestRenderer.act(async () => {
        answers[0](offer())
        answers[1](OFFER_BOLTZ)
      })
      await settle()

      expect(jest.mocked(sparkDiscardSendQuote).mock.calls.map(call => call[0]).sort()).toEqual(['bol', 'orc'])
    })

    describe('with quotes that lapse', () => {
      const pause = () =>
        ReactTestRenderer.act(async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
        })
      const lapsedThen = (after: (id: string) => Promise<SparkCrossChainQuote>) => {
        let calls = 0
        jest.mocked(sparkPrepareCrossChainSend).mockImplementation(id => {
          calls += 1
          const base = id === BOLTZ_BASE.id ? OFFER_BOLTZ : offer()
          return calls <= 2 ? Promise.resolve({ ...base, expiresAt: '2020-01-01T00:00:00Z' }) : after(id)
        })
      }
      beforeEach(() => {
        Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true })
      })

      const fresh = async (id: string) => {
        const base = id === BOLTZ_BASE.id ? OFFER_BOLTZ : offer()
        return { ...base, handle: `${base.handle}2`, estimatedOut: base.estimatedOut + 100_000 }
      }

      test('each line stays what it sends, and the line pressed is the one that updates', async () => {
        lapsedThen(fresh)
        const tree = await toReview()
        await pause()
        expect(sparkPrepareCrossChainSend).toHaveBeenLastCalledWith(BOLTZ_BASE.id, 50_000, 'sats')
        // The review's own figure and the line's.
        expect(flat(tree).match(/≈ 49\.5\s+USDT/g)).toHaveLength(2)

        await pressBtn(tree, 'Orchestra')
        await pause()
        expect(sparkPrepareCrossChainSend).toHaveBeenLastCalledWith(USDT_BASE.id, 50_000, 'sats')

        await pressBtn(tree, 'Boltz')
        await pressBtn(tree, 'Confirm send')
        expect(jest.mocked(sparkConfirmSend).mock.calls[0][0]).toBe('bol2')
      })

      test('a line pressed while the marked quote updates moves nothing', async () => {
        lapsedThen(() => new Promise(() => undefined))
        const tree = await toReview()
        await pause()

        await pressBtn(tree, 'Orchestra')

        const marked = tree.root.findAllByType(Touch).filter(node => node.props.state?.selected === true)
        expect(marked[0].findAllByType(Text).map(node => node.props.children)).toContain('Boltz')
      })
    })

    test('a quote that lapses updates only the one marked', async () => {
      const tree = await toReview()
      jest.mocked(sparkPrepareCrossChainSend).mockClear()
      jest.mocked(sparkConfirmSend).mockRejectedValueOnce(
        Object.assign(new Error('SdkError.Generic'), {
          tag: 'Generic',
          inner: ['Cross-chain quote has expired. Please re-prepare.'],
        }),
      )
      jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue({ ...OFFER_BOLTZ, handle: 'bol2' })

      await pressBtn(tree, 'Confirm send')

      expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
      expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(BOLTZ_BASE.id, 50_000, 'sats')
    })
  })

  describe('what the review says of the route', () => {
    const CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

    async function toReview(quote: SparkCrossChainQuote): Promise<ReactTestRenderer.ReactTestRenderer> {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [USDT_TRON] })
      jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(quote)
      const tree = await render()
      await pasteDestination(tree, 'TAddr')
      await enterAmount(tree, 50_000)
      return tree
    }
    const unbroken = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join('').replace(/\s/g, '')

    test('the contract waits one press, and copies whole', async () => {
      const tree = await toReview(offer({ contractAddress: CONTRACT }))
      expect(unbroken(tree)).not.toContain(CONTRACT)

      await pressBtn(tree, i18n.t('send.contract'))
      expect(unbroken(tree)).toContain(CONTRACT)

      const copy = tree.root.findAllByType(Touch).find(node => node.props.label === i18n.t('receive.copyAddress', { address: CONTRACT }))
      expect(texts(tree)).toContain(i18n.t('receive.tapToCopy'))
      await ReactTestRenderer.act(async () => copy?.props.onPress())
      expect(Clipboard.setString).toHaveBeenCalledWith(CONTRACT)
      expect(texts(tree)).toContain(i18n.t('receive.copied'))
      expect(texts(tree)).not.toContain(i18n.t('receive.tapToCopy'))
    })

    test('with no contract there is no line', async () => {
      const tree = await toReview(offer())

      expect(flat(tree)).not.toContain(i18n.t('send.contract'))
    })

    test('the provider reads by its name', async () => {
      const tree = await toReview(offer())

      expect(flat(tree)).toContain(i18n.t('send.crossChainNote', { provider: 'Orchestra' }))
      expect(flat(tree)).not.toContain('orchestra')
    })

    test('the note stays on the cross-chain review', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
      const tree = await render()
      await pasteDestination(tree, 'lnbc1pay')

      expect(flat(tree)).toContain('Confirm send')
      expect(flat(tree)).not.toContain('Orchestra')
    })
  })
})

describe('a quote that lapses on the review', () => {
  const NOW = Date.UTC(2026, 10, 4, 12, 0, 0)
  const IN_A_MINUTE = '2026-11-04T12:01:00Z'
  const oldRecipientGets = '49.5 USDC'
  const crossChainQuote = (over: Partial<SparkCrossChainQuote> = {}): SparkCrossChainQuote => ({
    handle: 'xc1',
    routeId: SOLANA_ROUTE.id,
    source: 'sats',
    amountIn: 50_000,
    feeSat: 120,
    estimatedOut: 49_500_000,
    feeAmount: 500_000,
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    provider: 'orchestra',
    expiresAt: IN_A_MINUTE,
    ...over,
  })
  const newer = crossChainQuote({ handle: 'xc2', estimatedOut: 48_000_000, expiresAt: '2026-11-04T12:10:00Z' })

  let now = NOW
  beforeEach(() => {
    now = NOW
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    Object.defineProperty(AppState, 'currentState', { value: 'active', configurable: true })
    jest.mocked(sparkPrepareCrossChainSend).mockReset()
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(crossChainQuote())
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'crossChainAddress',
      routes: [SOLANA_ROUTE, BASE_ROUTE],
    })
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 1_000_000, tokens: [] })
  })
  afterEach(() => {
    jest.useRealTimers()
    jest.mocked(Date.now).mockRestore()
  })

  async function review(asked = 50_000): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await pasteDestination(tree, 'SoLaNaAddr111')
    await pickFromSheet(tree, SOLANA_ROUTE.id)
    await pressBtn(tree, 'Add amount')
    await enterAmount(tree, asked)
    jest.mocked(sparkPrepareCrossChainSend).mockClear()
    return tree
  }

  // Back from the background, where the quote's own timer may never have run.
  async function comeBackAt(ms: number): Promise<void> {
    now = ms
    const handlers = jest
      .mocked(AppState.addEventListener)
      .mock.calls.filter(([event]) => event === 'change')
      .map(([, handler]) => handler as (state: string) => void)
    await ReactTestRenderer.act(async () => {
      handlers.forEach(handler => handler('active'))
    })
    await settle()
  }

  const confirmControl = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.label === i18n.t('send.confirm'))[0]

  test('Confirm on a lapsed quote never reaches the SDK, and asks for the same route and amount', async () => {
    const tree = await review(50_000)
    // A provider may price a little under what was asked, and the ask is what repeats.
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    now = NOW + 50_000
    await pressBtn(tree, 'Confirm send')

    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(SOLANA_ROUTE.id, 50_000, 'sats')
    expect(texts(tree)).toContain(i18n.t('send.quoteUpdated'))

    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('xc2', undefined)
  })

  test('the ask repeats, not the amount the quote came back with', async () => {
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(crossChainQuote({ amountIn: 49_990 }))
    const tree = await review(50_000)
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    await comeBackAt(NOW + 51_000)

    expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(SOLANA_ROUTE.id, 50_000, 'sats')
    expect(texts(tree)).toContain(i18n.t('send.quoteUpdated'))
  })

  test('the timer replaces the figures in place, ten seconds early, with Confirm off meanwhile', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] })
    const tree = await review()
    let answer: (q: SparkCrossChainQuote) => void = () => undefined
    jest.mocked(sparkPrepareCrossChainSend).mockReturnValue(new Promise(resolve => (answer = resolve)))

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(49_999)
    })
    await settle()
    expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()

    now = NOW + 50_000
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1)
    })
    await settle()
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
    expect(confirmControl(tree).props.disabled).toBe(true)
    // The old figures are off the screen, and the review is still there.
    expect(texts(tree).join(' ')).not.toContain(oldRecipientGets)
    expect(texts(tree)).toContain(i18n.t('send.recipientGets'))

    await ReactTestRenderer.act(async () => answer(newer))
    await settle()
    expect(confirmControl(tree).props.disabled).toBe(false)
    expect(texts(tree).join(' ')).toContain('48 USDC')
    expect(texts(tree)).toContain(i18n.t('send.quoteUpdated'))
  })

  test('a return from the background catches what the lost timer missed', async () => {
    await review()
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    await comeBackAt(NOW + 20_000)
    expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()

    await comeBackAt(NOW + 120_000)
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
  })

  test('nothing refreshes while the app is in the background', async () => {
    await review()
    Object.defineProperty(AppState, 'currentState', { value: 'background', configurable: true })
    await comeBackAt(NOW + 120_000)
    expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
  })

  test('a refresh never steps on a confirm in flight', async () => {
    jest.mocked(sparkConfirmSend).mockReturnValue(new Promise(() => undefined))
    const tree = await review()
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)

    await comeBackAt(NOW + 120_000)
    expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
  })

  test('a press during a refresh sends nothing', async () => {
    const tree = await review()
    jest.mocked(sparkPrepareCrossChainSend).mockReturnValue(new Promise(() => undefined))
    await comeBackAt(NOW + 120_000)

    await ReactTestRenderer.act(async () => confirmControl(tree).props.onPress())
    await settle()
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
  })

  test('an answer that lands after leaving the review is dropped', async () => {
    const tree = await review()
    let answer: (q: SparkCrossChainQuote) => void = () => undefined
    jest.mocked(sparkPrepareCrossChainSend).mockReturnValue(new Promise(resolve => (answer = resolve)))
    await comeBackAt(NOW + 120_000)

    await ReactTestRenderer.act(async () => mockPreventCb?.())
    await settle()
    await ReactTestRenderer.act(async () => answer(newer))
    await settle()

    expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
    expect(texts(tree)).not.toContain(i18n.t('send.quoteUpdated'))
  })

  test('a refused route leaves the review for the destination, and the lapsed quote never returns', async () => {
    const tree = await review()
    jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(
      Object.assign(new Error('CrossChainRouteUnavailable'), {
        tag: 'CrossChainRouteUnavailable',
        inner: { temporary: false },
      }),
    )
    await comeBackAt(NOW + 120_000)

    const shown = texts(tree)
    expect(shown).not.toContain(i18n.t('send.confirm'))
    expect(shown.join(' ')).not.toContain(oldRecipientGets)
    expect(shown).toContain(i18n.t('errors.routeUnavailable'))
    expect(shown).not.toContain(i18n.t('common.retry'))
    expect(shown).toContain(i18n.t('send.destination'))
    expect(sparkConfirmSend).not.toHaveBeenCalled()
  })

  test('a refused last route says none is left', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [SOLANA_ROUTE] })
    const tree = await render()
    await pasteDestination(tree, 'SoLaNaAddr111')
    await enterAmount(tree, 50_000)
    jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(
      Object.assign(new Error('CrossChainRouteUnavailable'), {
        tag: 'CrossChainRouteUnavailable',
        inner: { temporary: false },
      }),
    )
    await comeBackAt(NOW + 120_000)

    expect(texts(tree)).toContain(i18n.t('send.noRoutes'))
  })

  test('a refresh that fails offers the same ask again, from the destination', async () => {
    const tree = await review(50_000)
    jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(new Error('Network request failed'))
    await comeBackAt(NOW + 120_000)

    expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
    expect(texts(tree)).toContain(i18n.t('errors.offline'))
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    jest.mocked(sparkPrepareCrossChainSend).mockClear()
    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkPrepareCrossChainSend).toHaveBeenCalledWith(SOLANA_ROUTE.id, 50_000, 'sats')
    expect(texts(tree)).toContain(i18n.t('send.confirm'))
  })

  test('a refresh with no answer gives up at 15 s, and a late answer is dropped', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] })
    const tree = await review()
    let answer: (q: SparkCrossChainQuote) => void = () => undefined
    jest.mocked(sparkPrepareCrossChainSend).mockReturnValue(new Promise(resolve => (answer = resolve)))
    await comeBackAt(NOW + 120_000)

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(14_999)
    })
    await settle()
    expect(texts(tree)).toContain(i18n.t('send.confirm'))

    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1)
    })
    await settle()
    expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
    expect(texts(tree)).toContain(i18n.t('errors.offline'))

    await ReactTestRenderer.act(async () => answer(newer))
    await settle()
    expect(texts(tree)).not.toContain(i18n.t('send.confirm'))
  })

  test('a screen left open stops asking after three, until someone presses', async () => {
    const tree = await review()
    jest.mocked(sparkPrepareCrossChainSend).mockImplementation(async () => ({
      ...newer,
      handle: `xc-${now}`,
      expiresAt: new Date(now + 30_000).toISOString(),
    }))
    for (const later of [1, 2, 3, 4, 5]) {
      await comeBackAt(NOW + later * 60_000)
    }

    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(3)
    const shown = texts(tree)
    expect(shown).toContain(i18n.t('send.quoteStale'))
    expect(shown).toContain(i18n.t('send.refreshQuote'))
    expect(shown).not.toContain(i18n.t('send.confirm'))

    await pressBtn(tree, i18n.t('send.refreshQuote'))
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(4)
    expect(texts(tree)).toContain(i18n.t('send.confirm'))
  })

  test('a replaced quote leaves no handle behind that could still go out', async () => {
    const tree = await review()
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    jest.mocked(sparkDiscardSendQuote).mockClear()
    const lapsed = Object.assign(new Error('SdkError.InvalidInput'), {
      tag: 'InvalidInput',
      inner: Object.freeze(['Cross-chain quote has expired. Please re-prepare.']),
    })
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(lapsed)

    await pressBtn(tree, 'Confirm send')

    expect(sparkDiscardSendQuote).toHaveBeenCalledWith(crossChainQuote().handle)
    expect(sparkDiscardSendQuote).not.toHaveBeenCalledWith(newer.handle)
  })

  test('the line about a replaced quote goes when Confirm fails, beside the error', async () => {
    const tree = await review()
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    const lapsed = Object.assign(new Error('SdkError.InvalidInput'), {
      tag: 'InvalidInput',
      inner: Object.freeze(['Cross-chain quote has expired. Please re-prepare.']),
    })
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(lapsed)
    await pressBtn(tree, 'Confirm send')
    expect(texts(tree)).toContain(i18n.t('send.quoteUpdated'))

    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(new Error('send failed'))
    await pressBtn(tree, 'Confirm send')

    expect(texts(tree)).not.toContain(i18n.t('send.quoteUpdated'))
  })

  test('a quote lapsed by the SDK alone is replaced, never reported as a send in doubt', async () => {
    const tree = await review()
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(newer)
    // As the binding throws it: the class name in the message, the sentence only in inner[0].
    const refusal = Object.assign(new Error('SdkError.InvalidInput'), {
      tag: 'InvalidInput',
      inner: Object.freeze(['Cross-chain quote has expired. Please re-prepare.']),
    })
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(refusal)
    await pressBtn(tree, 'Confirm send')

    const shown = texts(tree)
    expect(sparkPrepareCrossChainSend).toHaveBeenCalledTimes(1)
    expect(shown).not.toContain(i18n.t('send.checkHistory'))
    expect(shown).not.toContain(i18n.t('errors.expiredInvoice'))
    expect(shown).toContain(i18n.t('send.confirm'))
    expect(shown).toContain(i18n.t('send.quoteUpdated'))
  })

  describe('after Confirm', () => {
    const overlay = (tree: ReactTestRenderer.ReactTestRenderer) => {
      const { label, amount, fiat } = tree.root.findByType(ReceivedOverlay).props
      return { label, value: amount.value, unit: amount.unit, fiat }
    }
    const onItsWay = {
      label: i18n.t('send.onTheWay'),
      value: 50_000,
      unit: i18n.t('common.sats'),
      fiat: undefined,
    }

    test('a return to the app with the overlay up asks for no quote and moves no figure', async () => {
      const tree = await review()
      now = NOW + 49_000
      await pressBtn(tree, 'Confirm send')
      expect(overlay(tree)).toEqual(onItsWay)

      jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(new Error('network'))
      await comeBackAt(NOW + 51_000)

      expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
      expect(overlay(tree)).toEqual(onItsWay)
    })

    test('the quote timer firing under the overlay asks for no quote and moves no figure', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] })
      const tree = await review()
      now = NOW + 47_000
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(47_000)
      })
      jest.mocked(sparkConfirmSend).mockResolvedValue('pending')
      await pressBtn(tree, 'Confirm send')
      expect(overlay(tree)).toEqual(onItsWay)

      jest.mocked(sparkPrepareCrossChainSend).mockRejectedValue(new Error('network'))
      now = NOW + 50_000
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(3_000)
      })
      await settle()

      expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
      expect(overlay(tree)).toEqual(onItsWay)
    })

    // Another way to lose the quote under a send: a link opens this screen while the confirm is out.
    test('a quote replaced while the confirm is out leaves the figures of what was sent', async () => {
      const tree = await review()
      let answer: (status: 'complete') => void = () => undefined
      jest.mocked(sparkConfirmSend).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      await pressBtn(tree, 'Confirm send')

      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
      jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'other', amount: 7_777, fee: 1 })
      mockRouteParams = { destination: 'lnbc1other', picked: 1 }
      await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
      await settle()
      await ReactTestRenderer.act(async () => answer('complete'))
      await settle()

      expect(overlay(tree)).toEqual(onItsWay)
    })

    test('a rate that lands after the press changes nothing on the overlay', async () => {
      let rates: (value: Record<string, number>) => void = () => undefined
      jest.mocked(sparkGetFiatRates).mockReturnValueOnce(new Promise(resolve => (rates = resolve)))
      const tree = await review()
      let answer: (status: 'complete') => void = () => undefined
      jest.mocked(sparkConfirmSend).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      await pressBtn(tree, 'Confirm send')

      await ReactTestRenderer.act(async () => rates({ USD: 100_000 }))
      await settle()
      await ReactTestRenderer.act(async () => answer('complete'))
      await settle()

      expect(overlay(tree)).toEqual(onItsWay)
    })
  })

  test('a quote with no readable end sets no timer and goes to the SDK', async () => {
    jest.mocked(sparkPrepareCrossChainSend).mockResolvedValue(crossChainQuote({ expiresAt: 'soon' }))
    const tree = await review()
    await comeBackAt(NOW + 3_600_000)
    expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()

    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('xc1', undefined)
  })

  test('a plain send never asks about a quote', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    await comeBackAt(NOW + 3_600_000)

    expect(sparkPrepareCrossChainSend).not.toHaveBeenCalled()
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
  })
})

describe('the asset and amount sent are the ones on screen', () => {
  const BIP21 = 'bitcoin:bc1qx?amount=0.001&spark=spark1merchant'
  const namesSats = { kind: 'sparkAddress' as const, resolved: 'spark1merchant', requestedAmount: 100_000 }
  // What the SDK does with what it is given: the token asked for comes back on the quote.
  // The quote's amount is a double, as the SDK's answer reaches the screen.
  const prepareEchoes = async (_dest: string, amount?: number | bigint, token?: string): Promise<SparkSendQuote> => ({
    handle: 'h',
    amount: Number(amount ?? 0),
    fee: 0,
    tokenIdentifier: token,
  })
  const rerender = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
    await settle()
  }
  const hero = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(Amount).map(({ props }) => ({ value: props.value, unit: props.unit }))
  const confirmDisabled = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findByType(GradientButton).props.disabled
  const onTokenScreen = async () => {
    mockRouteParams = { assetId: USDB.identifier } as typeof mockRouteParams
    const tree = await render()
    return tree
  }
  const openAssetPicker = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    const row = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => String(node.props.label ?? '').endsWith(i18n.t('send.chooseAsset')))
    await ReactTestRenderer.act(async () => row?.props.onPress())
    await settle()
  }
  const sats100k = [{ value: formatSats(100_000), unit: i18n.t('common.sats') }]

  beforeEach(() => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
    jest.mocked(sparkPrepareSend).mockImplementation(prepareEchoes)
    jest.mocked(sparkInspectDestination).mockResolvedValue(namesSats)
  })

  const assertSatsLeave = (tree: ReactTestRenderer.ReactTestRenderer) => {
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    expect(sparkPrepareSend).toHaveBeenCalledWith('spark1merchant', 100_000, undefined)
    expect(hero(tree)).toEqual(sats100k)
  }

  test('a QR that names sats, on a Send opened on a token, spends sats', async () => {
    const tree = await onTokenScreen()
    mockRouteParams = { destination: BIP21, picked: 1 }
    await rerender(tree)
    assertSatsLeave(tree)
  })

  test('a pasted link that names sats, on a Send opened on a token, spends sats', async () => {
    const tree = await onTokenScreen()
    await pasteDestination(tree, BIP21)
    assertSatsLeave(tree)
  })

  test('a tag that names sats, on a Send opened on a token, spends sats', async () => {
    jest.mocked(nfcState).mockResolvedValue('on')
    jest.mocked(readNfcDestination).mockResolvedValueOnce({ kind: 'address', value: BIP21 })
    const tree = await onTokenScreen()
    await pressBtn(tree, i18n.t('send.nfc'))
    jest.mocked(nfcState).mockResolvedValue('unsupported')
    assertSatsLeave(tree)
  })

  test('a typed destination that names sats, on a Send opened on a token, spends sats', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask', 'Date'] })
    try {
      const tree = await onTokenScreen()
      await ReactTestRenderer.act(async () => {
        tree.root.findAllByType(TextInput)[0].props.onChangeText(BIP21)
      })
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(400)
      })
      await settle()
      assertSatsLeave(tree)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a link handed in over a token invoice spends none of that token', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValueOnce({
      kind: 'sparkAddress',
      tokenIdentifier: USDB.identifier,
      amount: 2_000_000,
    })
    jest.mocked(sparkPrepareSend).mockResolvedValueOnce({
      handle: 'h0',
      amount: 2_000_000,
      fee: 0,
      tokenIdentifier: USDB.identifier,
    })
    const tree = await render()
    await pasteDestination(tree, 'spark1invoice')
    expect(sparkPrepareSend).toHaveBeenLastCalledWith('spark1invoice', undefined, USDB.identifier)

    mockRouteParams = { destination: BIP21, picked: 1 }
    await rerender(tree)

    expect(sparkPrepareSend).toHaveBeenLastCalledWith('spark1merchant', 100_000, undefined)
    expect(hero(tree)).toEqual(sats100k)
  })

  test('the picked token still spends, in the amount typed in it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'spark1bare')
    await openAssetPicker(tree)
    await pickFromSheet(tree, USDB.identifier)
    await pressBtn(tree, i18n.t('send.amountToken', { ticker: USDB.ticker }))
    await enterAmount(tree, 1.5)

    expect(sparkPrepareSend).toHaveBeenCalledWith('spark1bare', 1_500_000n, USDB.identifier)
    expect(hero(tree)).toEqual([{ value: '1.5', unit: USDB.ticker }])
  })

  test('a retry spends what the amount was typed in, and the review names it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    jest.mocked(sparkPrepareSend).mockRejectedValueOnce(new Error('Fee increased since prepare'))
    const tree = await render()
    await pasteDestination(tree, 'spark1bare')
    await openAssetPicker(tree)
    await pickFromSheet(tree, USDB.identifier)
    await pressBtn(tree, i18n.t('send.amountToken', { ticker: USDB.ticker }))
    await enterAmount(tree, 1.5)
    await openAssetPicker(tree)
    await pickFromSheet(tree, BITCOIN_ASSET_ID)
    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkPrepareSend).toHaveBeenLastCalledWith('spark1bare', 1_500_000n, USDB.identifier)
    expect(hero(tree)).toEqual([{ value: '1.5', unit: USDB.ticker }])

    await pressBtn(tree, 'Confirm send')
    const { amount } = tree.root.findByType(ReceivedOverlay).props
    expect({ value: amount.value, unit: amount.unit }).toEqual({ value: 1.5, unit: USDB.ticker })
  })

  test('an asset picked up late never renames a quote already drawn', async () => {
    let info: (value: SparkWalletInfo) => void = () => undefined
    jest.mocked(sparkGetWalletInfo).mockReturnValueOnce(new Promise(resolve => (info = resolve)))
    const tree = await onTokenScreen()
    await pasteDestination(tree, BIP21)
    await ReactTestRenderer.act(async () => info(WITH_USDB))
    await settle()
    assertSatsLeave(tree)
  })

  test('a token invoice read before the balance names its token', async () => {
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'sparkAddress',
      tokenIdentifier: USDB.identifier,
      amount: 2_000_000,
    })
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'h',
      amount: 2_000_000,
      fee: 0,
      tokenIdentifier: USDB.identifier,
    })
    const tree = await render()
    await pasteDestination(tree, 'spark1invoice')

    expect(hero(tree)).toEqual([{ value: '2', unit: USDB.ticker }])
  })

  test('an amountless token invoice read before the balance asks in its token', async () => {
    jest.mocked(sparkGetWalletInfo).mockReturnValue(new Promise(() => undefined))
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'sparkAddress',
      tokenIdentifier: USDB.identifier,
    })
    const tree = await render()
    await pasteDestination(tree, 'spark1invoice')

    expect(tree.root.findByType(AmountSheet).props.unit).toBe(USDB.ticker)
  })

  test('a token nothing can name on a balance past its wait says so under the skeleton', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 0, tokens: [] })
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'sparkAddress',
      tokenIdentifier: 'btkn1stranger',
      amount: 2_000_000,
    })
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'h',
      amount: 2_000_000,
      fee: 0,
      tokenIdentifier: 'btkn1stranger',
    })
    const tree = await render()
    await pasteDestination(tree, 'spark1invoice')

    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(texts(tree)).toContain(i18n.t('home.notUpdated'))
  })

  test('a token nothing can name is drawn in no unit and cannot be confirmed', async () => {
    const stranger = 'btkn1stranger'
    let info: (value: SparkWalletInfo) => void = () => undefined
    jest.mocked(sparkGetWalletInfo).mockReturnValueOnce(new Promise(resolve => (info = resolve)))
    jest.mocked(sparkInspectDestination).mockResolvedValue({
      kind: 'sparkAddress',
      tokenIdentifier: stranger,
      amount: 2_000_000,
    })
    jest.mocked(sparkPrepareSend).mockResolvedValue({
      handle: 'h',
      amount: 2_000_000,
      fee: 0,
      tokenIdentifier: stranger,
    })
    const tree = await render()
    await pasteDestination(tree, 'spark1invoice')

    expect(hero(tree)).toEqual([])
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(confirmDisabled(tree)).toBe(true)

    await ReactTestRenderer.act(async () =>
      info({
        sync: 'synced',
        recoverableSat: 0,
        balanceSat: 0,
        tokens: [{ identifier: stranger, ticker: 'STR', name: 'Stranger', decimals: 2, balanceBaseUnits: 9_000_000 }],
      }),
    )
    await settle()

    expect(hero(tree)).toEqual([{ value: '20,000', unit: 'STR' }])
    expect(confirmDisabled(tree)).toBe(false)
  })

  test('the overlay names the token the quote spent', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'spark1bare')
    await openAssetPicker(tree)
    await pickFromSheet(tree, USDB.identifier)
    await pressBtn(tree, i18n.t('send.amountToken', { ticker: USDB.ticker }))
    await enterAmount(tree, 1.5)
    await pressBtn(tree, 'Confirm send')

    const { amount, fiat } = tree.root.findByType(ReceivedOverlay).props
    expect({ value: amount.value, unit: amount.unit, fiat }).toEqual({
      value: 1.5,
      unit: USDB.ticker,
      fiat: undefined,
    })
  })
})

describe('a destination handed back to this same screen', () => {
  const rerender = async (tree: ReactTestRenderer.ReactTestRenderer) => {
    await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
    await settle()
  }

  test('the same contact picked again prepares again', async () => {
    mockRouteParams = { destination: 'lnbc1contact', picked: 1 }
    const tree = await render()
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)

    await ReactTestRenderer.act(async () => mockPreventCb?.())
    await settle()
    mockRouteParams = { destination: 'lnbc1contact', picked: 2 }
    await rerender(tree)

    expect(sparkPrepareSend).toHaveBeenCalledTimes(2)
    expect(texts(tree)).toContain(i18n.t('send.confirm'))
  })

  test('nothing from the last destination survives it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    jest.mocked(sparkParseLnurlPay).mockResolvedValue({
      handle: 'first',
      minSat: 1,
      maxSat: 100_000,
      commentAllowed: 0,
      payee: 'first@breez.tips',
    })
    const tree = await render()
    await pasteDestination(tree, 'first@breez.tips')
    expect(sparkParseLnurlPay).toHaveBeenCalledTimes(1)

    mockRouteParams = { destination: 'second@breez.tips', picked: 1 }
    await rerender(tree)

    // A remembered endpoint would pay the first address the amount meant for the second.
    expect(sparkParseLnurlPay).toHaveBeenCalledTimes(2)
    expect(sparkParseLnurlPay).toHaveBeenLastCalledWith('second@breez.tips')
  })

  test('an older prepare still in flight never lands on the new destination', async () => {
    let answer: (q: SparkSendQuote) => void = () => undefined
    jest.mocked(sparkPrepareSend).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1first')

    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'second', amount: 2000, fee: 1 })
    mockRouteParams = { destination: 'lnbc1second', picked: 1 }
    await rerender(tree)
    await ReactTestRenderer.act(async () => answer({ handle: 'first', amount: 7777, fee: 1 }))
    await settle()

    expect(texts(tree).join(' ')).not.toContain(formatSats(7777))
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledWith('second', undefined)
  })
})

describe('what the recipient said', () => {
  async function lnurlReview(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    jest.mocked(sparkParseLnurlPay).mockResolvedValue({
      handle: 'lnurl',
      minSat: 1,
      maxSat: 100_000,
      commentAllowed: 0,
      payee: 'alice@breez.tips',
    })
    jest.mocked(sparkPrepareLnurlPay).mockResolvedValue({ handle: 'prep', amount: 5000, fee: 1 })
    const tree = await render()
    await pasteDestination(tree, 'alice@breez.tips')
    await enterAmount(tree, 5000)
    return tree
  }

  test('shows on a finished pay', async () => {
    jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({
      status: 'complete',
      successAction: { kind: 'message', text: 'Thanks!' },
    })
    const tree = await lnurlReview()
    await pressBtn(tree, 'Confirm send')

    expect(tree.root.findByType(ReceivedOverlay).props.note).toBe('Thanks!')
  })

  test('waits for a pay that the follow-up confirms', async () => {
    jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({
      status: 'pending',
      successAction: { kind: 'message', text: 'Thanks!' },
    })
    jest.mocked(sparkFollowSend).mockResolvedValue('complete')
    const tree = await lnurlReview()
    await pressBtn(tree, 'Confirm send')

    expect(tree.root.findByType(ReceivedOverlay).props.note).toBe('Thanks!')
  })

  test('never shows beside On the way', async () => {
    jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({
      status: 'pending',
      successAction: { kind: 'message', text: 'Thanks!' },
    })
    jest.mocked(sparkFollowSend).mockResolvedValue('pending')
    const tree = await lnurlReview()
    await pressBtn(tree, 'Confirm send')

    const overlay = tree.root.findByType(ReceivedOverlay)
    expect(overlay.props.label).toBe(i18n.t('send.onTheWay'))
    expect(overlay.props.note).toBeUndefined()
  })

  test('opens nothing on its own, and draws a link as its description only', async () => {
    jest.mocked(sparkConfirmLnurlPay).mockResolvedValue({
      status: 'complete',
      successAction: { kind: 'url', url: 'https://x.example/receipt', description: 'Your receipt' },
    })
    const openURL = jest.spyOn(Linking, 'openURL')
    const tree = await lnurlReview()
    await pressBtn(tree, 'Confirm send')

    expect(tree.root.findByType(ReceivedOverlay).props.note).toBe('Your receipt')
    expect(openURL).not.toHaveBeenCalled()
    openURL.mockRestore()
  })
})

describe('a dollar wallet sending', () => {
  const RATE = 100_000
  const usdb = (balanceBaseUnits: number): SparkWalletInfo['tokens'][number] =>
    ({ identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits } as SparkWalletInfo['tokens'][number])
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AmountSheet)
  const wallet = (balanceSat: number, token: number, sync: BalanceSync = 'synced'): SparkWalletInfo => ({
    sync,
    recoverableSat: 0,
    balanceSat,
    tokens: token > 0 ? [usdb(token)] : [],
  })
  const CONVERTED = {
    handle: 'c1',
    amount: 12_300,
    fee: 7,
    conversion: { tokenIdentifier: USDB.identifier, amountIn: 12_400_000, amountOut: 12_307, fee: 9_000_000 },
  }

  beforeEach(() => {
    mockDollarMode = true
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: RATE })
    jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(0, 12_400_000))
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h', amount: 0, fee: 0 })
  })

  afterEach(() => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
  })

  async function toSheet(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await pasteDestination(tree, 'lnbc1amountless')
    return tree
  }

  async function toReview(quote: object = CONVERTED): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await toSheet()
    jest.mocked(sparkPrepareSend).mockResolvedValue(quote as Awaited<ReturnType<typeof sparkPrepareSend>>)
    await enterAmount(tree, 12_300)
    return tree
  }

  test('the sheet opens in dollars, and the SDK is asked in sats', async () => {
    const tree = await toSheet()

    expect(sheet(tree).props.initialDenom).toBe('fiat')
    expect(sheet(tree).props.fiatCurrency).toBe('USD')
    expect(sheet(tree).props.fiatRate).toBe(RATE)

    jest.mocked(sparkPrepareSend).mockResolvedValue(CONVERTED)
    await enterAmount(tree, 12_300)

    expect(sparkPrepareSend).toHaveBeenLastCalledWith('lnbc1amountless', 12_300, undefined)
  })

  test('with no rate it opens in sats, with no dollar anywhere', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const tree = await toSheet()

    expect(sheet(tree).props.initialDenom).toBeUndefined()

    jest.mocked(sparkPrepareSend).mockResolvedValue(CONVERTED)
    await enterAmount(tree, 12_300)

    expect(texts(tree).join(' ')).not.toContain('≈ $')
    expect(tree.root.findAllByType(SegmentedControl)).toHaveLength(0)
  })

  test('a token keeps its own unit', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await render()
    await pasteDestination(tree, 'spark1addr')
    await pressBtn(tree, 'Asset')
    await pickFromSheet(tree, USDB.identifier)
    await pressBtn(tree, i18n.t('send.amountToken', { ticker: 'USDB' }))

    expect(sheet(tree).props.unit).toBe('USDB')
    expect(sheet(tree).props.initialDenom).toBeUndefined()
  })

  test('dollars made from sats carry ≈, and what converts is exact', async () => {
    const tree = await toReview()
    const shown = texts(tree)

    expect(shown).toContain('≈ $12.30')
    expect(shown).toContain('12.4 USDB')
    expect(shown.join(' ')).not.toContain('≈ 12.4')
  })

  test('a balance equal to amountIn confirms, since the SDK covers a conversion with amountIn alone', async () => {
    const tree = await toReview()

    expect(tree.root.findAllByType(GradientButton).at(-1)!.props.disabled).toBe(false)
  })

  test('a balance under amountIn is refused', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(0, 12_399_999))
    const tree = await toReview()

    expect(tree.root.findAllByType(GradientButton).at(-1)!.props.disabled).toBe(true)
  })

  test('Converts and the conversion cost are two lines, and the cost never adds to what leaves', async () => {
    const tree = await toReview()
    const shown = texts(tree)

    // 12.4 dollars in for 12 307 sats at spot: about 0.75%, whatever the quote's fee says.
    expect(shown).toContain(i18n.t('send.conversionFee'))
    expect(shown).toContain('≈ 0.75%')
    expect(shown).toContain('12.4 USDB')
    expect(shown.join(' ')).not.toContain('21.4')
  })

  // A dollar sale's amountOut is the floor it signs, 1% under what the pool gives, so the cost reads
  // the pool and never the allowance.
  test('a dollar sale states the cost of the pool, not the slippage allowed', async () => {
    const tree = await toReview({
      ...CONVERTED,
      conversion: { ...CONVERTED.conversion, amountOut: 12_226, expectedOut: 12_350 },
    })

    expect(texts(tree)).toContain('≈ 0.4%')
  })

  test('with sats chosen, every line is in sats', async () => {
    const tree = await toReview()

    await ReactTestRenderer.act(async () => {
      tree.root.findByType(SegmentedControl).props.onChange('sats')
    })
    await settle()
    const shown = texts(tree)

    expect(shown.join(' ')).not.toContain('≈ $')
    expect(shown).toContain(`${formatSats(12_307)} sats`)
    expect(shown).toContain(`${formatSats(7)} sats`)
  })

  test('sats that cover the send draw no conversion, and the figure stays in dollars', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(50_000, 0))
    const tree = await toReview({ handle: 'p', amount: 12_300, fee: 7 })
    const shown = texts(tree)

    expect(shown).toContain('≈ $12.30')
    expect(shown).not.toContain(i18n.t('send.converts'))
    expect(shown).not.toContain(i18n.t('send.conversionFee'))

    let finish: (status: 'complete') => void = () => undefined
    jest.mocked(sparkConfirmSend).mockReturnValue(new Promise(resolve => (finish = resolve)))
    await pressBtn(tree, i18n.t('send.confirm'))
    expect(texts(tree)).not.toContain(i18n.t('send.stageConverting'))
    await ReactTestRenderer.act(async () => {
      finish('complete')
    })
  })

  test('the overlay draws what was read at the press, with the sats beneath', async () => {
    const tree = await toReview()

    await pressBtn(tree, i18n.t('send.confirm'))

    const overlay = tree.root.findByType(ReceivedOverlay).props
    expect(overlay.amount.format(overlay.amount.value)).toBe('≈ $12.30')
    expect(overlay.beneath).toBe(`${formatSats(12_300)} sats`)
    expect(overlay.fiat).toBeUndefined()
  })

  describe('the step beside the spinner', () => {
    const stage = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
      texts(tree).filter(text => [i18n.t('send.stageConverting'), i18n.t('send.stageSending')].includes(text))

    test('names the conversion until the SDK answers the send, then the sending that is still out', async () => {
      const tree = await toReview()
      let answer: (status: 'pending') => void = () => undefined
      jest.mocked(sparkConfirmSend).mockReturnValue(new Promise(resolve => (answer = resolve)))
      let follow: (status: 'complete') => void = () => undefined
      jest.mocked(sparkFollowSend).mockReturnValue(new Promise(resolve => (follow = resolve)))

      await pressBtn(tree, i18n.t('send.confirm'))
      expect(stage(tree)).toEqual([i18n.t('send.stageConverting')])

      await ReactTestRenderer.act(async () => {
        answer('pending')
      })
      await settle()
      expect(stage(tree)).toEqual([i18n.t('send.stageSending')])

      await ReactTestRenderer.act(async () => {
        follow('complete')
      })
      await settle()
      expect(stage(tree)).toEqual([])
    })

    test('a send that ends in its own answer is followed by nothing, so no step stays out', async () => {
      const tree = await toReview()
      jest.mocked(sparkConfirmSend).mockResolvedValue('complete')
      jest.mocked(sparkFollowSend).mockReturnValue(new Promise(() => undefined))

      await pressBtn(tree, i18n.t('send.confirm'))

      expect(sparkFollowSend).not.toHaveBeenCalled()
      expect(stage(tree)).toEqual([])
      expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(1)
    })

    // payments/send/mod.rs refuses it ahead of the conversion, so no token moved.
    test('a lapsed invoice with a conversion ahead of it is no send in doubt', async () => {
      const tree = await toReview()
      const lapsed = Object.assign(new Error('SdkError.InvalidInput'), {
        tag: 'InvalidInput',
        inner: Object.freeze(['Invoice has expired']),
      })
      jest.mocked(sparkConfirmSend).mockRejectedValue(lapsed)

      await pressBtn(tree, i18n.t('send.confirm'))

      expect(texts(tree)).toContain(i18n.t('errors.expiredInvoice'))
      expect(texts(tree)).not.toContain(i18n.t('send.checkHistory'))
    })

    test('a fee the SDK refused with a conversion ahead of it stays in doubt', async () => {
      const tree = await toReview()
      jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('Fee increased since prepare. Please retry.'))

      await pressBtn(tree, i18n.t('send.confirm'))

      expect(texts(tree)).toContain(i18n.t('send.checkHistory'))
    })

    // A conversion's token leg answers AlreadyExists about no invoice (spark/src/token/allowance/error.rs).
    const tokenAlreadyExists = () =>
      Object.assign(new Error('SdkError.SparkError'), {
        tag: 'SparkError',
        inner: Object.freeze(['status: AlreadyExists, message: "DUPLICATE_OPERATION"']),
      })

    test('AlreadyExists with a conversion ahead of it names no invoice and keeps the doubt', async () => {
      const tree = await toReview()
      jest.mocked(sparkConfirmSend).mockRejectedValue(tokenAlreadyExists())

      await pressBtn(tree, i18n.t('send.confirm'))

      expect(texts(tree)).toContain(i18n.t('send.failed'))
      expect(texts(tree)).not.toContain(i18n.t('errors.invoiceUsed'))
      expect(texts(tree)).toContain(i18n.t('send.checkHistory'))
    })

    // spark.ts keys no send with a conversion, so this holds the line's rule on Try again as well.
    test('AlreadyExists on Try again of a send with a conversion names no invoice', async () => {
      jest.mocked(sparkSendTakesKey).mockReturnValue(true)
      try {
        const tree = await toReview()
        jest.mocked(sparkConfirmSendHeld).mockRejectedValue(new Error('Network request failed'))
        jest.mocked(sparkRetryHeldSend).mockRejectedValue(tokenAlreadyExists())
        await pressBtn(tree, i18n.t('send.confirm'))

        await pressBtn(tree, i18n.t('common.retry'))

        expect(sparkRetryHeldSend).toHaveBeenCalledTimes(1)
        expect(texts(tree)).toContain(i18n.t('send.failed'))
        expect(texts(tree)).not.toContain(i18n.t('errors.invoiceUsed'))
      } finally {
        jest.mocked(sparkSendTakesKey).mockReturnValue(false)
      }
    })

    test('a failure takes it down at once and it never says sent', async () => {
      const tree = await toReview()
      jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('send failed'))

      await pressBtn(tree, i18n.t('send.confirm'))

      expect(stage(tree)).toEqual([])
      expect(texts(tree)).not.toContain(i18n.t('send.sent'))
    })
  })

  describe('the bitcoin address it cannot pay yet', () => {
    const toAddress = async (): Promise<ReactTestRenderer.ReactTestRenderer> => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
      const tree = await render()
      await pasteDestination(tree, 'bc1qaddr')
      return tree
    }

    test('asks for no quote and offers the way out', async () => {
      const tree = await toAddress()

      expect(sparkPrepareSend).not.toHaveBeenCalled()
      await pressBtn(tree, i18n.t('send.openDollarWallet'))
      expect(mockNavigate).toHaveBeenCalledWith('StableBalance')
    })

    test('a silent payment address stops the same way', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'silentPaymentAddress', resolved: 'sp1qaddr' })
      const tree = await render()
      await pasteDestination(tree, 'sp1qaddr')

      expect(sparkPrepareSend).not.toHaveBeenCalled()
      expect(texts(tree).join(' ')).toContain(i18n.t('send.onchainNeedsBitcoinMode').slice(0, 30))
    })

    test('back with the mode off the words go, the address stays, and nothing prepares alone', async () => {
      const tree = await toAddress()
      expect(texts(tree).join(' ')).toContain(i18n.t('send.onchainNeedsBitcoinMode').slice(0, 30))

      mockDollarMode = false
      await ReactTestRenderer.act(async () => {
        tree.update(<SendSpark />)
      })
      await settle()

      expect(texts(tree).join(' ')).not.toContain(i18n.t('send.onchainNeedsBitcoinMode').slice(0, 30))
      expect(texts(tree)).not.toContain(i18n.t('send.openDollarWallet'))
      expect(tree.root.findByType(TextInput).props.value).toBe('bc1qaddr')
      expect(sparkPrepareSend).not.toHaveBeenCalled()
    })
  })

  describe('use all', () => {
    const SALE = {
      handle: 'sale',
      amount: 12_307,
      fee: 7,
      feesIncluded: true,
      receives: 12_300,
      conversion: CONVERTED.conversion,
    }

    test('a bolt11 goes out as a sale of the whole USDB balance, fees included', async () => {
      const tree = await toSheet()
      jest.mocked(sparkPrepareSend).mockResolvedValue(SALE)

      await ReactTestRenderer.act(async () => {
        sheet(tree).props.onUseAll()
      })
      await settle()

      expect(sparkPrepareSend).toHaveBeenLastCalledWith('lnbc1amountless', 12_400_000, undefined, true, true)
    })

    test('a lightning address does too', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
      jest.mocked(sparkParseLnurlPay).mockResolvedValue({
        handle: 'l1',
        minSat: 1,
        maxSat: 1_000_000,
        commentAllowed: 0,
        payee: 'a@b.c',
      })
      const tree = await render()
      await pasteDestination(tree, 'a@b.c')
      jest.mocked(sparkPrepareLnurlPay).mockResolvedValue(SALE)

      await ReactTestRenderer.act(async () => {
        sheet(tree).props.onUseAll()
      })
      await settle()

      expect(sparkPrepareLnurlPay).toHaveBeenLastCalledWith('l1', 12_400_000, undefined, true, true)
    })

    test.each([
      ['a figure not synced', { info: wallet(0, 12_400_000, 'stale') }],
      ['USDB past a safe integer', { info: wallet(0, 2 ** 60) }],
      ['no USDB', { info: wallet(5000, 0) }],
      ['the SDK saying the mode is off', { modeOn: false }],
    ])('is not offered with %s', async (_name, { info, modeOn }: { info?: SparkWalletInfo; modeOn?: boolean }) => {
      if (info) {
        jest.mocked(sparkGetWalletInfo).mockResolvedValue(info)
      }
      if (modeOn === false) {
        jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
      }
      const tree = await toSheet()

      expect(sheet(tree).props.visible).toBe(true)
      expect(sheet(tree).props.onUseAll).toBeUndefined()
    })

    test('is not offered to a Spark destination', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
      const tree = await render()
      await pasteDestination(tree, 'spark1addr')
      await pressBtn(tree, i18n.t('send.addAmount'))

      expect(sheet(tree).props.onUseAll).toBeUndefined()
    })

    test('the review says what the SDK says arrives, when that is under the balance', async () => {
      const tree = await toSheet()
      jest.mocked(sparkPrepareSend).mockResolvedValue({ ...SALE, receives: 4000, amount: 4007 })

      await ReactTestRenderer.act(async () => {
        sheet(tree).props.onUseAll()
      })
      await settle()

      expect(texts(tree)).toContain(i18n.t('send.receives'))
      expect(texts(tree)).toContain('≈ $4.00')
    })
  })

  describe('available', () => {
    test('is a figure in dollars, USDB plus sats at market, that locks nothing', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(1_000, 12_400_000))
      const tree = await toSheet()

      expect(sheet(tree).props.availableNote).toBe('≈ $13.40')
      expect(sheet(tree).props.available).toBeUndefined()
    })

    test('past that figure the sheet lets it through and the review refuses', async () => {
      const tree = await toSheet()
      jest.mocked(sparkPrepareSend).mockResolvedValue({
        ...CONVERTED,
        conversion: { ...CONVERTED.conversion, amountIn: 99_000_000 },
      })

      await enterAmount(tree, 99_000)

      expect(sparkPrepareSend).toHaveBeenLastCalledWith('lnbc1amountless', 99_000, undefined)
      expect(tree.root.findAllByType(GradientButton).at(-1)!.props.disabled).toBe(true)
    })

    test('says nothing on a figure not synced', async () => {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet(1_000, 12_400_000, 'stale'))
      const tree = await toSheet()

      expect(sheet(tree).props.availableNote).toBeUndefined()
    })
  })
})

test('a rate landing during a send moves no figure of the review', async () => {
  mockDollarMode = true
  let land: (rates: Record<string, number>) => void = () => undefined
  jest.mocked(sparkGetFiatRates).mockReturnValue(new Promise(resolve => (land = resolve)))
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h', amount: 12_300, fee: 7 })
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 50_000, tokens: [] })
  let finish: (status: 'complete') => void = () => undefined
  jest.mocked(sparkConfirmSend).mockReturnValue(new Promise(resolve => (finish = resolve)))
  const tree = await render()
  await pasteDestination(tree, 'lnbc1fixed')
  await pressBtn(tree, i18n.t('send.confirm'))

  await ReactTestRenderer.act(async () => {
    land({ USD: 100_000 })
  })
  await settle()

  expect(sparkConfirmSend).toHaveBeenCalled()
  expect(texts(tree).join(' ')).not.toContain('≈ $12.30')
  expect(tree.root.findAllByType(SegmentedControl)).toHaveLength(0)

  await ReactTestRenderer.act(async () => {
    finish('complete')
  })
  await settle()
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
})

// A send spends the sat leaves an exit under way is taking on-chain, so Send stays shut while a plan of
// the signing wallet is alive, and says so with a way to the exit.
describe('an emergency exit under way', () => {
  const shownText = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ')

  let planRead: jest.SpyInstance | null = null

  beforeEach(async () => {
    __setEmergencyExitLiveForTests(true)
    mockConnected.id = 'primary'
    await forgetExitPlan('primary')
  })

  afterEach(async () => {
    planRead?.mockRestore()
    planRead = null
    await forgetExitPlan('primary')
    await forgetExitPlan('signer')
    __setEmergencyExitLiveForTests(null)
  })

  test('shuts Send on open with its line and a way to the exit', async () => {
    await saveExitPlan(planOf())
    const tree = await render()
    expect(shownText(tree)).toContain(i18n.t('emergencyExit.sendHeld'))
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
    await pressBtn(tree, i18n.t('emergencyExit.sendHeldOpen'))
    expect(mockNavigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'all' })
  })

  test('a destination handed in on open prepares nothing', async () => {
    await saveExitPlan(planOf())
    mockRouteParams = { destination: 'lnbc1invoice' }
    const tree = await render()
    expect(sparkInspectDestination).not.toHaveBeenCalled()
    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(shownText(tree)).toContain(i18n.t('emergencyExit.sendHeld'))
  })

  test('a plan the platform will not read holds Send with a line of its own', async () => {
    await saveExitPlan(planOf())
    const real = RNFS.readFile
    planRead = jest
      .spyOn(RNFS, 'readFile')
      .mockImplementation((path: string, encoding?: string) =>
        path.includes('exit-plan-') ? Promise.reject(new Error('EACCES')) : real(path, encoding),
      )
    mockRouteParams = { destination: 'lnbc1invoice' }
    const tree = await render()
    expect(shownText(tree)).toContain(i18n.t('emergencyExit.sendHeldUnread'))
    expect(shownText(tree)).not.toContain(i18n.t('emergencyExit.sendHeld'))
    expect(sparkPrepareSend).not.toHaveBeenCalled()
  })

  test('a plan that ended holds nothing', async () => {
    await saveExitPlan(planOf({ verdict: 'closed', closure: 'later' }))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    expect(sparkPrepareSend).toHaveBeenCalledWith('lnbc1invoice', undefined, undefined)
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(shownText(tree)).not.toContain(i18n.t('emergencyExit.sendHeld'))
  })

  test('an exit that starts after the review holds the confirm, and nothing is sent', async () => {
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    expect(sparkPrepareSend).toHaveBeenCalledTimes(1)
    await saveExitPlan(planOf())
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(sparkConfirmLnurlPay).not.toHaveBeenCalled()
    expect(shownText(tree)).toContain(i18n.t('emergencyExit.sendHeld'))
    expect(shownText(tree)).not.toContain('Confirm send')
    await pressBtn(tree, i18n.t('emergencyExit.sendHeldOpen'))
    expect(mockNavigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'all' })
  })

  test('the wallet that signs is the one asked', async () => {
    await saveExitPlan(planOf({ walletId: 'signer' }))
    mockConnected.id = 'signer'
    const tree = await render()
    expect(shownText(tree)).toContain(i18n.t('emergencyExit.sendHeld'))
  })

  // spark.ts holds the confirm too, for an exit that starts between this screen's read and the SDK call.
  test.each([
    ['exit', 'emergencyExit.sendHeld'],
    ['unread', 'emergencyExit.sendHeldUnread'],
  ] as const)('a confirm spark.ts refuses (%s) says why, as nothing left', async (hold, key) => {
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(new SpendHeldByExit(hold))
    const tree = await render()
    await pasteDestination(tree, 'lnbc1invoice')
    await pressBtn(tree, 'Confirm send')
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(shownText(tree)).toContain(i18n.t(key))
    expect(shownText(tree)).not.toContain(i18n.t('send.failed'))
    await pressBtn(tree, i18n.t('emergencyExit.sendHeldOpen'))
    expect(mockNavigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'all' })
  })
})

import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import Clipboard from '@react-native-clipboard/clipboard'
import { SendSpark } from '../src/screens/SendSpark'
import { AmountSheet } from '../src/components/AmountSheet'
import { GradientButton } from '../src/components/GradientButton'
import { ReceivedOverlay } from '../src/components/ReceivedOverlay'
import { formatSats } from '../src/wallet/amount'
import { USDB } from '../src/wallet/tokens'
import { carriesToken } from '../src/wallet/sendAll'
import { lnurlText } from '../src/wallet/lnaddress'
import { ChunkedAddress } from '../src/components/ChunkedAddress'
import { DetailsFold } from '../src/components/DetailsFold'
import {
  sparkConfirmSend,
  sparkFollowSend,
  sparkGetWalletInfo,
  sparkInspectDestination,
  sparkPrepareSend,
  type SparkCrossChainRoute,
  type SparkSendQuote,
} from '../src/wallet/spark'

// The review and amount steps of Send (audit SND-05, SND-06): what Back keeps and how the amount comes
// back. The SDK, the dollar mode and navigation are stood in for as sendSpark.test.tsx does.

let mockDollarMode = false
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => mockDollarMode,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

// The display currency, settable so a test can hold sats typed in dollars against another money.
let mockDisplayCurrency = 'USD'
jest.mock('../src/wallet/fiatDisplay', () => ({
  resolveDisplayCurrency: async () => mockDisplayCurrency,
}))

let mockRouteParams: { destination?: string; picked?: number; assetId?: string } = {}
jest.mock('../src/wallet/spark', () => ({
  onSparkConnected: () => () => undefined,
  onSparkSynced: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  sparkSyncState: () => 'synced',
  sparkConnectedWalletId: () => 'primary',
  sparkClassify: jest.fn(async () => 'bolt11'),
  sparkInspectDestination: jest.fn(),
  sparkPrepareSend: jest.fn(),
  sparkPrepareCrossChainSend: jest.fn(),
  sparkDiscardSendQuote: jest.fn(),
  sparkConfirmSend: jest.fn(),
  sparkSendTakesKey: jest.fn(() => false),
  sparkConfirmSendHeld: jest.fn(),
  sparkRetryHeldSend: jest.fn(),
  sparkDropHeldSend: jest.fn(),
  sparkParseLnurlPay: jest.fn(),
  sparkPrepareLnurlPay: jest.fn(),
  sparkConfirmLnurlPay: jest.fn(),
  sparkFollowSend: jest.fn(),
  sparkSentRail: jest.fn(() => undefined),
  sparkGetWalletInfo: jest.fn(),
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
// The header button and the Android back key reach the screen through usePreventRemove.
let mockPreventActive = false
let mockPreventCb: (() => void) | null = null
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => unknown) =>
    require('react').useEffect(() => {
      const cleanup = callback()
      return typeof cleanup === 'function' ? cleanup : undefined
    }, [callback]),
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn(), replace: jest.fn(), setOptions: jest.fn() }),
  useRoute: () => ({ params: mockRouteParams }),
  usePreventRemove: (active: boolean, cb: () => void) => {
    mockPreventActive = active
    mockPreventCb = cb
  },
}))

const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
const TIERS = {
  fast: { minerSat: 1000, sparkSat: 500, totalSat: 1500 },
  medium: { minerSat: 500, sparkSat: 500, totalSat: 1000 },
  slow: { minerSat: 100, sparkSat: 300, totalSat: 400 },
  estimate: false,
}
const onchainQuote = (amount: number, handle = 'oc1'): SparkSendQuote => ({
  handle,
  amount,
  fee: 1000,
  onchainFees: TIERS,
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

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

function pressable(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(
      n =>
        // A choice row speaks its value before its action, as ChoiceRow joins them.
        String(n.props.label ?? '').endsWith(label) ||
        n.findAllByType(Text).some(txt => txt.props.children === label),
    )
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = pressable(tree, label)
  if (!target) {
    throw new Error(`not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle()
}

async function paste(tree: ReactTestRenderer.ReactTestRenderer, text: string): Promise<void> {
  jest.mocked(Clipboard.getString).mockResolvedValue(text)
  await press(tree, i18n.t('send.paste'))
}

const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AmountSheet)

async function typeAmount(
  tree: ReactTestRenderer.ReactTestRenderer,
  value: number | undefined,
  denom?: 'sats' | 'btc' | 'fiat',
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    sheet(tree).props.onConfirm(value, denom)
  })
  await settle()
}

async function back(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    mockPreventCb?.()
  })
  await settle()
}

const field = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)[0]
const confirmButton = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(GradientButton).find(node => node.props.label === i18n.t('send.confirm'))
const amountShown = (sat: number) => i18n.t('send.sats', { amount: formatSats(sat) })

beforeEach(() => {
  mockDollarMode = false
  mockDisplayCurrency = 'USD'
  jest.clearAllMocks()
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 500_000, tokens: [] })
  jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress' })
  jest.mocked(sparkPrepareSend).mockResolvedValue(onchainQuote(20_000))
  jest.mocked(sparkConfirmSend).mockResolvedValue('pending')
  jest.mocked(sparkFollowSend).mockResolvedValue('pending')
  jest.mocked(Clipboard.getString).mockResolvedValue('')
})

async function toOnchainReview(): Promise<ReactTestRenderer.ReactTestRenderer> {
  const tree = await render()
  await paste(tree, ADDRESS)
  await typeAmount(tree, 20_000, 'sats')
  expect(confirmButton(tree)).toBeDefined()
  return tree
}

describe('Back from a review keeps the destination and the amount', () => {
  test('the system back returns to the field with the address and the amount typed', async () => {
    const tree = await toOnchainReview()

    await back()

    expect(confirmButton(tree)).toBeUndefined()
    expect(field(tree).props.value).toBe(ADDRESS)
    expect(texts(tree)).toContain(amountShown(20_000))
    expect(mockPreventActive).toBe(false)
  })

  test('Back to destination after a send that failed keeps them too', async () => {
    jest.mocked(sparkConfirmSend).mockResolvedValue('failed')
    const tree = await toOnchainReview()
    await press(tree, i18n.t('send.confirm'))

    await press(tree, i18n.t('send.backToDestination'))

    expect(field(tree).props.value).toBe(ADDRESS)
    expect(texts(tree)).toContain(amountShown(20_000))
    expect(texts(tree)).not.toContain(i18n.t('send.failed'))
  })

  test('the amount kept goes into the next prepare unchanged', async () => {
    const tree = await toOnchainReview()
    await back()

    await press(tree, i18n.t('send.changeAmount'))
    expect(sheet(tree).props.visible).toBe(true)
    await typeAmount(tree, 30_000, 'sats')

    expect(sparkPrepareSend).toHaveBeenLastCalledWith(ADDRESS, 30_000, undefined)
  })

  test('a send in doubt keeps its line on the destination it went to', async () => {
    jest.mocked(sparkConfirmSend).mockRejectedValue(new Error('Network request failed'))
    const tree = await toOnchainReview()
    await press(tree, i18n.t('send.confirm'))

    await press(tree, i18n.t('send.backToDestination'))

    expect(texts(tree)).toContain(i18n.t('send.checkHistory'))
    expect(field(tree).props.value).toBe(ADDRESS)
  })

  test('an invoice that names its amount comes back with a way to its review', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 5 })
    const tree = await render()
    await paste(tree, 'lnbc1invoice')
    await back()

    expect(field(tree).props.value).toBe('lnbc1invoice')
    expect(pressable(tree, i18n.t('send.addAmount'))).toBeUndefined()
    await press(tree, i18n.t('send.review'))

    expect(sparkPrepareSend).toHaveBeenCalledTimes(2)
    expect(confirmButton(tree)).toBeDefined()
  })

  test('READS: back while the amount is being priced drops that prepare and keeps the amount', async () => {
    const tree = await render()
    await paste(tree, ADDRESS)
    let answer!: (quote: SparkSendQuote) => void
    jest.mocked(sparkPrepareSend).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    await typeAmount(tree, 20_000, 'sats')
    expect(mockPreventActive).toBe(true)

    await back()
    await ReactTestRenderer.act(async () => answer(onchainQuote(20_000)))
    await settle()

    expect(confirmButton(tree)).toBeUndefined()
    expect(field(tree).props.value).toBe(ADDRESS)
    expect(texts(tree)).toContain(amountShown(20_000))
  })

  test('back before the destination is read leaves Send, as there is no review behind it', async () => {
    const tree = await render()
    jest.mocked(sparkInspectDestination).mockReturnValueOnce(new Promise(() => undefined))
    await paste(tree, ADDRESS)

    expect(mockPreventActive).toBe(false)
    expect(tree.root.findAllByType(ReceivedOverlay)).toHaveLength(0)
  })
})

describe('a destination that takes an amount keeps a way to give it', () => {
  test('closing the keypad with nothing typed leaves Add amount on screen', async () => {
    const tree = await render()
    await paste(tree, ADDRESS)
    expect(sheet(tree).props.visible).toBe(true)

    await typeAmount(tree, undefined)

    expect(pressable(tree, i18n.t('send.addAmount'))).toBeDefined()
    await press(tree, i18n.t('send.addAmount'))
    expect(sheet(tree).props.visible).toBe(true)
  })

  test('a prepare that failed leaves the amount a tap away', async () => {
    jest.mocked(sparkPrepareSend).mockRejectedValueOnce(new Error('boom'))
    const tree = await render()
    await paste(tree, ADDRESS)
    await typeAmount(tree, 20_000, 'sats')

    expect(texts(tree)).toContain(i18n.t('send.reviewFailed'))
    expect(pressable(tree, i18n.t('send.changeAmount'))).toBeDefined()
  })

  test('a lightning address closed without an amount keeps it too', async () => {
    const { sparkParseLnurlPay } = jest.requireMock('../src/wallet/spark')
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    sparkParseLnurlPay.mockResolvedValue({ handle: 'l1', minSat: 1, maxSat: 1_000_000, commentAllowed: 0, payee: 'alice@example.com' })
    const tree = await render()
    await paste(tree, 'alice@example.com')

    await ReactTestRenderer.act(async () => sheet(tree).props.onClose())
    await settle()

    expect(pressable(tree, i18n.t('send.addAmount'))).toBeDefined()
  })

  describe('READS: a read that fails before the keypad', () => {
    const spark = () => jest.requireMock('../src/wallet/spark')
    const READ = { handle: 'l1', minSat: 10, maxSat: 1_000_000, commentAllowed: 0, payee: 'alice@example.com' }
    const offline = () => new Error('Network request failed')
    // A test that stops before its queued answer is read would hand that answer to the next test.
    afterEach(() => {
      spark().sparkParseLnurlPay.mockReset()
      jest.mocked(sparkPrepareSend).mockReset()
    })
    const unreadAddress = async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
      spark().sparkParseLnurlPay.mockRejectedValueOnce(offline())
      const tree = await render()
      await paste(tree, 'alice@example.com')
      expect(texts(tree)).toContain(i18n.t('errors.offline'))
      expect(sheet(tree).props.visible).toBe(false)
      return tree
    }

    test("a lightning address whose endpoint could not be read keeps Add amount, which reads it first", async () => {
      const tree = await unreadAddress()
      spark().sparkParseLnurlPay.mockResolvedValueOnce(READ)

      await press(tree, i18n.t('send.addAmount'))

      expect(spark().sparkParseLnurlPay).toHaveBeenCalledTimes(2)
      expect(sheet(tree).props).toMatchObject({
        visible: true,
        min: 10,
        title: i18n.t('send.payAddress', { name: 'alice@example.com' }),
      })
    })

    test('a read that fails again keeps it still', async () => {
      const tree = await unreadAddress()
      spark().sparkParseLnurlPay.mockRejectedValueOnce(offline())

      await press(tree, i18n.t('send.addAmount'))

      expect(sheet(tree).props.visible).toBe(false)
      expect(texts(tree)).toContain(i18n.t('errors.offline'))
      expect(pressable(tree, i18n.t('send.addAmount'))).toBeDefined()
    })

    test('a read that answers after Back opens nothing, and the way stays', async () => {
      const tree = await unreadAddress()
      let answer!: (read: typeof READ) => void
      spark().sparkParseLnurlPay.mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      await press(tree, i18n.t('send.addAmount'))
      expect(mockPreventActive).toBe(true)

      await back()
      await ReactTestRenderer.act(async () => answer(READ))
      await settle()

      expect(sheet(tree).props.visible).toBe(false)
      expect(field(tree).props.value).toBe('alice@example.com')
      expect(pressable(tree, i18n.t('send.addAmount'))).toBeDefined()
    })

    test('an invoice whose pricing failed can be read again, and opens the keypad when it names no amount', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
      jest.mocked(sparkPrepareSend).mockRejectedValueOnce(offline())
      const tree = await render()
      await paste(tree, 'lnbc1noamount')
      expect(texts(tree)).toContain(i18n.t('errors.offline'))
      jest.mocked(sparkPrepareSend).mockResolvedValueOnce({ handle: 'h0', amount: 0, fee: 0 })

      await press(tree, i18n.t('send.review'))

      expect(sparkPrepareSend).toHaveBeenCalledTimes(2)
      expect(sheet(tree).props.visible).toBe(true)
    })

    test('control: an address the first read refused draws no such way', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'other' })
      const tree = await render()
      await paste(tree, 'nonsense')

      expect(pressable(tree, i18n.t('send.review'))).toBeUndefined()
      expect(pressable(tree, i18n.t('send.addAmount'))).toBeUndefined()
    })
  })
})

describe('the keypad reopens on the last amount and unit typed', () => {
  test('the sheet is handed the amount and the unit it was typed in', async () => {
    const tree = await render()
    await paste(tree, ADDRESS)
    expect(sheet(tree).props.initial).toBe('')
    await typeAmount(tree, 20_000, 'btc')
    await back()

    await press(tree, i18n.t('send.changeAmount'))

    expect(sheet(tree).props.initial).toBe('20000')
    expect(sheet(tree).props.initialDenom).toBe('btc')
  })

  test('a new destination starts empty again', async () => {
    const tree = await render()
    await paste(tree, ADDRESS)
    await typeAmount(tree, 20_000, 'sats')
    await back()

    await paste(tree, 'bc1qother')

    expect(sheet(tree).props.initial).toBe('')
    expect(texts(tree)).not.toContain(amountShown(20_000))
  })
})

describe('the amount comes back only in the unit it was typed in', () => {
  const spark = () => jest.requireMock('../src/wallet/spark')
  // One token on one chain from two providers, so a single line where the better offer can move the
  // route: the first takes sats only, the second USDB as well.
  const SATS_ONLY: SparkCrossChainRoute = {
    id: 'a|solana|USDC|orchestra',
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    provider: 'orchestra',
    accepts: { btc: true, usdb: false },
  }
  const TAKES_USDB: SparkCrossChainRoute = { ...SATS_ONLY, id: 'a|solana|USDC|boltz', provider: 'boltz', accepts: { btc: true, usdb: true } }
  const offerOf = (route: SparkCrossChainRoute, estimatedOut: number) => ({
    handle: `q-${route.provider}`,
    routeId: route.id,
    source: 'sats' as const,
    amountIn: 50_000,
    feeSat: 100,
    estimatedOut,
    feeAmount: 0,
    chain: route.chain,
    asset: route.asset,
    decimals: route.decimals,
    provider: route.provider,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  })
  const priced = (outs: Record<string, number>) =>
    spark().sparkPrepareCrossChainSend.mockImplementation(async (id: string) =>
      offerOf(id === TAKES_USDB.id ? TAKES_USDB : SATS_ONLY, outs[id]),
    )
  // Whichever line the step draws for the amount, Change amount over a kept one or Add amount.
  const openAmount = async (tree: ReactTestRenderer.ReactTestRenderer) =>
    press(tree, pressable(tree, i18n.t('send.changeAmount')) ? i18n.t('send.changeAmount') : i18n.t('send.addAmount'))

  beforeEach(() => {
    spark().sparkGetFiatRates.mockResolvedValue({ USD: 100_000 })
  })
  afterEach(() => {
    spark().sparkGetFiatRates.mockResolvedValue({})
  })

  async function dollarsPricedOn(outs: Record<string, number>): Promise<ReactTestRenderer.ReactTestRenderer> {
    mockDollarMode = true
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [SATS_ONLY, TAKES_USDB] })
    priced(outs)
    const tree = await render()
    await paste(tree, '0xabc')
    // The first route takes sats only, so the dollar wallet types dollars at the rate, handed back as sats.
    expect(sheet(tree).props).toMatchObject({ dollars: false, initialDenom: 'fiat' })
    await typeAmount(tree, 50_000, 'fiat')
    expect(spark().sparkPrepareCrossChainSend).toHaveBeenCalledWith(TAKES_USDB.id, 50_000, 'sats')
    return tree
  }

  test('the better offer moving the send to a USDB route never reopens the sats as dollars', async () => {
    const tree = await dollarsPricedOn({ [SATS_ONLY.id]: 49_000_000, [TAKES_USDB.id]: 49_500_000 })
    await back()

    expect(texts(tree)).not.toContain(amountShown(50_000))
    await openAmount(tree)

    expect(sheet(tree).props.dollars).toBe(true)
    expect(sheet(tree).props.initial).toBe('')
    spark().sparkPrepareCrossChainSend.mockClear()
    await typeAmount(tree, 50)
    expect(spark().sparkPrepareCrossChainSend).toHaveBeenCalledWith(TAKES_USDB.id, 50_000_000, 'usdb')
    expect(spark().sparkPrepareCrossChainSend).not.toHaveBeenCalledWith(TAKES_USDB.id, 50_000_000_000, 'usdb')

    // Dollars typed there come back as the same dollars.
    await back()
    await openAmount(tree)
    expect(sheet(tree).props).toMatchObject({ dollars: true, initial: '50' })
  })

  test('an offer picked on the review that moves the route does the same', async () => {
    const tree = await dollarsPricedOn({ [SATS_ONLY.id]: 49_500_000, [TAKES_USDB.id]: 49_000_000 })
    await press(tree, 'Boltz')
    await back()

    await openAmount(tree)

    expect(sheet(tree).props.dollars).toBe(true)
    expect(sheet(tree).props.initial).toBe('')
  })

  test('control: with the route kept, the sats come back in the dollars they were typed in', async () => {
    const tree = await dollarsPricedOn({ [SATS_ONLY.id]: 49_500_000, [TAKES_USDB.id]: 49_000_000 })
    await back()

    expect(texts(tree)).toContain(amountShown(50_000))
    await openAmount(tree)

    expect(sheet(tree).props).toMatchObject({ dollars: false, initial: '50000', initialDenom: 'fiat', fiatCurrency: 'USD' })
  })

  async function satsOnUsdbRoute(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [TAKES_USDB] })
    priced({ [TAKES_USDB.id]: 49_000_000 })
    const tree = await render()
    await paste(tree, '0xabc')
    expect(sheet(tree).props.dollars).toBe(false)
    await typeAmount(tree, 50_000, 'sats')
    await back()
    return tree
  }

  test('READS: a dollar mode read landing after the sats were typed never reopens them as dollars', async () => {
    const tree = await satsOnUsdbRoute()

    mockDollarMode = true
    await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
    await settle()

    expect(texts(tree)).not.toContain(amountShown(50_000))
    await openAmount(tree)
    expect(sheet(tree).props.dollars).toBe(true)
    expect(sheet(tree).props.initial).toBe('')
  })

  test('control: with the mode unchanged the sats come back', async () => {
    const tree = await satsOnUsdbRoute()

    await openAmount(tree)

    expect(sheet(tree).props).toMatchObject({ dollars: false, initial: '50000', initialDenom: 'sats' })
  })

  test('sats typed in dollars open in sats once the toggle holds another money', async () => {
    mockDollarMode = true
    mockDisplayCurrency = 'BRL'
    spark().sparkGetFiatRates.mockResolvedValue({ USD: 100_000, BRL: 550_000 })
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    spark().sparkParseLnurlPay.mockResolvedValue({ handle: 'l1', minSat: 1, maxSat: 1_000_000, commentAllowed: 0, payee: 'alice@example.com' })
    spark().sparkPrepareLnurlPay.mockResolvedValue({ handle: 'p1', amount: 50_000, fee: 3 })
    const tree = await render()
    await paste(tree, 'alice@example.com')
    expect(sheet(tree).props).toMatchObject({ fiatCurrency: 'USD', initialDenom: 'fiat' })
    await typeAmount(tree, 50_000, 'fiat')
    await back()

    mockDollarMode = false
    await ReactTestRenderer.act(async () => tree.update(<SendSpark />))
    await settle()
    await openAmount(tree)

    expect(sheet(tree).props).toMatchObject({ fiatCurrency: 'BRL', initial: '50000', initialDenom: 'sats' })
  })

  test('a token amount never comes back as sats after the asset moves to bitcoin', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 100_000,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: USDB.decimals, balanceBaseUnits: 25_000_000 },
      ],
    })
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 's1', amount: 5_000_000, fee: 0, tokenIdentifier: USDB.identifier })
    mockRouteParams = { assetId: USDB.identifier }
    const tree = await render()
    await paste(tree, 'spark1bare')
    await press(tree, i18n.t('send.amountToken', { ticker: USDB.ticker }))
    await ReactTestRenderer.act(async () => sheet(tree).props.onConfirm(5_000_000n))
    await settle()
    await back()
    await openAmount(tree)
    expect(sheet(tree).props.initial).toBe('5')
    await ReactTestRenderer.act(async () => sheet(tree).props.onClose())
    await settle()

    const { AssetPickerSheet } = require('../src/components/AssetPickerSheet')
    const picker = tree.root
      .findAllByType(AssetPickerSheet)
      .find(node => node.props.title === i18n.t('send.chooseAsset'))
    const bitcoin = picker?.props.items.find((item: { assetId: string }) => item.assetId !== picker.props.selectedId)
    await ReactTestRenderer.act(async () => picker?.props.onSelect(bitcoin.assetId))
    await settle()
    await openAmount(tree)

    expect(sheet(tree).props.unit).toBe('sats')
    expect(sheet(tree).props.initial).toBe('')
  })

  // Each writer below lets the typed amount go where the unit gate alone would hand it back.
  describe('a route change or Use all lets the amount typed go', () => {
    const ON_BASE: SparkCrossChainRoute = { ...SATS_ONLY, id: 'a|base|USDC|orchestra', chain: 'base' }
    const pickRoute = async (tree: ReactTestRenderer.ReactTestRenderer, id: string) => {
      const { AssetPickerSheet } = require('../src/components/AssetPickerSheet')
      const picker = tree.root
        .findAllByType(AssetPickerSheet)
        .find(node => node.props.title === i18n.t('send.chooseRoute'))
      await ReactTestRenderer.act(async () => picker?.props.onSelect(id))
      await settle()
    }
    const openRoutes = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      const row = tree.root.findAll(
        n => n.props.accessibilityLabel === i18n.t('send.chooseRoute') && typeof n.props.onPress === 'function',
      )[0]
      await ReactTestRenderer.act(async () => row.props.onPress())
      await settle()
    }
    const useAll = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      await ReactTestRenderer.act(async () => sheet(tree).props.onUseAll())
      await settle()
    }

    test('another network picked after Back opens the keypad empty', async () => {
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [SATS_ONLY, ON_BASE] })
      spark().sparkPrepareCrossChainSend.mockImplementation(async (id: string) =>
        offerOf(id === ON_BASE.id ? ON_BASE : SATS_ONLY, 49_000_000),
      )
      const tree = await render()
      await paste(tree, '0xabc')
      await pickRoute(tree, SATS_ONLY.id)
      await openAmount(tree)
      await typeAmount(tree, 50_000, 'sats')
      expect(spark().sparkPrepareCrossChainSend).toHaveBeenCalledWith(SATS_ONLY.id, 50_000, 'sats')
      await back()
      expect(texts(tree)).toContain(amountShown(50_000))

      await openRoutes(tree)
      await pickRoute(tree, ON_BASE.id)

      expect(texts(tree)).not.toContain(amountShown(50_000))
      await openAmount(tree)
      expect(sheet(tree).props.initial).toBe('')
    })

    test('Use all after an amount was typed opens the keypad empty after Back', async () => {
      const tree = await render()
      await paste(tree, ADDRESS)
      await typeAmount(tree, 20_000, 'sats')
      await back()
      await openAmount(tree)
      expect(sheet(tree).props.initial).toBe('20000')

      await useAll(tree)
      expect(confirmButton(tree)).toBeDefined()
      await back()

      expect(texts(tree)).not.toContain(amountShown(20_000))
      expect(pressable(tree, i18n.t('send.addAmount'))).toBeDefined()
      await openAmount(tree)
      expect(sheet(tree).props.initial).toBe('')
    })

    test('Use all of the dollar balance after dollars were typed opens the keypad empty after Back', async () => {
      mockDollarMode = true
      spark().sparkGetStableBalance.mockResolvedValue(true)
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({
        sync: 'synced',
        recoverableSat: 0,
        balanceSat: 0,
        tokens: [
          { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: USDB.decimals, balanceBaseUnits: 12_400_000 },
        ],
      })
      jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
      const converted = {
        handle: 'c1',
        amount: 12_300,
        fee: 7,
        conversion: { tokenIdentifier: USDB.identifier, amountIn: 12_400_000, amountOut: 12_307, fee: 9_000_000 },
      }
      // An invoice that names no amount opens the keypad once its pricing says so.
      jest.mocked(sparkPrepareSend).mockResolvedValueOnce({ handle: 'h0', amount: 0, fee: 0 }).mockResolvedValue(converted)
      try {
        const tree = await render()
        await paste(tree, 'lnbc1amountless')
        expect(sheet(tree).props.visible).toBe(true)
        await typeAmount(tree, 12_300)
        expect(confirmButton(tree)).toBeDefined()
        await back()
        await openAmount(tree)
        expect(sheet(tree).props.initial).not.toBe('')

        await useAll(tree)
        expect(sparkPrepareSend).toHaveBeenLastCalledWith('lnbc1amountless', 12_400_000, undefined, true, true)
        await back()

        await openAmount(tree)
        expect(sheet(tree).props.initial).toBe('')
      } finally {
        spark().sparkGetStableBalance.mockResolvedValue(false)
      }
    })
  })
})

describe('AmountSheet opens a sats amount in the unit it was typed in', () => {
  test('in BTC the entry reads the sats as bitcoin', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <AmountSheet
          visible
          unit="sats"
          allowDecimal={false}
          satsBtcToggle
          initialDenom="btc"
          initial="20000"
          parse={raw => (/^\d+$/.test(raw) ? Number(raw) : null)}
          onConfirm={() => undefined}
          onClose={() => undefined}
        />,
      )
    })
    mounted = tree
    expect(texts(tree).join(' ')).toContain('0.0002')
  })
})

describe('a fee that moved at the press is priced again and asks for a new press', () => {
  const feeMoved = () => new Error('Fee increased since prepare. Please retry.')

  test('the same destination and amount are priced again, and the review shows the new fee', async () => {
    const tree = await toOnchainReview()
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(feeMoved())
    jest.mocked(sparkPrepareSend).mockResolvedValueOnce({ ...onchainQuote(20_000, 'oc2'), onchainFees: { ...TIERS, medium: { minerSat: 900, sparkSat: 500, totalSat: 1400 } } })

    await press(tree, i18n.t('send.confirm'))

    expect(sparkPrepareSend).toHaveBeenLastCalledWith(ADDRESS, 20_000, undefined)
    expect(texts(tree)).toContain(i18n.t('send.feeMovedReview'))
    expect(texts(tree)).toContain(i18n.t('send.sats', { amount: formatSats(1400) }))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('send.checkHistory'))
    // Nothing is signed at the new fee until the person presses again.
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(confirmButton(tree)?.props.disabled).toBe(false)

    await press(tree, i18n.t('send.confirm'))
    expect(sparkConfirmSend).toHaveBeenLastCalledWith('oc2', 'medium')
    expect(sparkConfirmSend).toHaveBeenCalledTimes(2)
  })

  test('an LNURL pay is priced again with its amount and note', async () => {
    const spark = jest.requireMock('../src/wallet/spark')
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    spark.sparkParseLnurlPay.mockResolvedValue({ handle: 'l1', minSat: 1, maxSat: 1_000_000, commentAllowed: 50, payee: 'alice@example.com' })
    spark.sparkPrepareLnurlPay.mockResolvedValue({ handle: 'p1', amount: 5000, fee: 3 })
    spark.sparkConfirmLnurlPay.mockRejectedValueOnce(feeMoved())
    const tree = await render()
    await paste(tree, 'alice@example.com')
    await ReactTestRenderer.act(async () => sheet(tree).props.onConfirm(5000, 'sats', undefined, 'hi'))
    await settle()

    await press(tree, i18n.t('send.confirm'))

    expect(spark.sparkPrepareLnurlPay).toHaveBeenCalledTimes(2)
    expect(spark.sparkPrepareLnurlPay).toHaveBeenLastCalledWith('l1', 5000, 'hi')
    expect(texts(tree)).toContain(i18n.t('send.feeMovedReview'))
    expect(spark.sparkConfirmLnurlPay).toHaveBeenCalledTimes(1)
  })

  test('the line goes with the next press', async () => {
    const tree = await toOnchainReview()
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(feeMoved())
    await press(tree, i18n.t('send.confirm'))
    jest.mocked(sparkConfirmSend).mockReturnValueOnce(new Promise(() => undefined))

    await press(tree, i18n.t('send.confirm'))

    expect(texts(tree)).not.toContain(i18n.t('send.feeMovedReview'))
  })

  test('a cross-chain quote is asked again for its route and amount, and asks for a new press', async () => {
    const spark = jest.requireMock('../src/wallet/spark')
    const route = {
      id: 'sol-addr|solana|USDC|orchestra',
      chain: 'solana',
      asset: 'USDC',
      decimals: 6,
      provider: 'orchestra' as const,
      accepts: { btc: true, usdb: false },
    }
    const quoteOf = (handle: string, feeSat: number) => ({
      handle,
      routeId: route.id,
      source: 'sats' as const,
      amountIn: 50_000,
      feeSat,
      estimatedOut: 49_500_000,
      feeAmount: 500_000,
      chain: 'solana',
      asset: 'USDC',
      decimals: 6,
      provider: 'orchestra' as const,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    })
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'crossChainAddress', routes: [route] })
    spark.sparkPrepareCrossChainSend.mockResolvedValueOnce(quoteOf('xc1', 120)).mockResolvedValueOnce(quoteOf('xc2', 300))
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(feeMoved())
    const tree = await render()
    await paste(tree, '0xabc')
    await typeAmount(tree, 50_000, 'sats')

    await press(tree, i18n.t('send.confirm'))

    expect(spark.sparkPrepareCrossChainSend).toHaveBeenCalledTimes(2)
    expect(spark.sparkPrepareCrossChainSend).toHaveBeenLastCalledWith(route.id, 50_000, 'sats')
    expect(texts(tree)).toContain(i18n.t('send.feeMovedReview'))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('send.checkHistory'))
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(confirmButton(tree)?.props.disabled).toBe(false)
  })

  test('READS: an answer that comes after Back draws no review', async () => {
    const tree = await toOnchainReview()
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(feeMoved())
    let answer!: (quote: SparkSendQuote) => void
    jest.mocked(sparkPrepareSend).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    await press(tree, i18n.t('send.confirm'))

    await back()
    await ReactTestRenderer.act(async () => answer(onchainQuote(20_000, 'oc2')))
    await settle()

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree)).not.toContain(i18n.t('send.feeMovedReview'))
    expect(field(tree).props.value).toBe(ADDRESS)
    expect(texts(tree)).toContain(amountShown(20_000))
  })

  test('READS: a pricing that fails leaves the destination with the amount and the reason', async () => {
    const tree = await toOnchainReview()
    jest.mocked(sparkConfirmSend).mockRejectedValueOnce(feeMoved())
    jest.mocked(sparkPrepareSend).mockRejectedValueOnce(new Error('Network request failed'))

    await press(tree, i18n.t('send.confirm'))

    expect(confirmButton(tree)).toBeUndefined()
    expect(texts(tree)).toContain(i18n.t('errors.offline'))
    expect(pressable(tree, i18n.t('send.changeAmount'))).toBeDefined()
  })
})

describe('an LNURL names who it pays on the keypad and the review', () => {
  const LNURL = 'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns'
  const spark = () => jest.requireMock('../src/wallet/spark')
  const toLnurl = async (read: { payee: string; description?: string }, kind: 'lnurlPay' | 'lightningAddress' = 'lnurlPay', text = LNURL) => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind })
    spark().sparkParseLnurlPay.mockResolvedValue({ handle: 'l1', minSat: 1, maxSat: 1_000_000, commentAllowed: 0, ...read })
    spark().sparkPrepareLnurlPay.mockResolvedValue({ handle: 'p1', amount: 5000, fee: 3, description: 'order 42' })
    const tree = await render()
    await paste(tree, text)
    return tree
  }
  const drawnOutsideFold = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAllByType(ChunkedAddress)
      .filter(node => {
        for (let up = node.parent; up; up = up.parent) {
          if (up.type === DetailsFold) {
            return false
          }
        }
        return true
      })
      .map(node => node.props.value)

  test('the domain the SDK read heads the keypad and the review, and the lnurl1 string waits in a fold', async () => {
    const tree = await toLnurl({ payee: 'shop.example.com' })
    const named = i18n.t('send.payAddress', { name: 'shop.example.com' })
    expect(sheet(tree).props.title).toBe(named)

    await typeAmount(tree, 5000, 'sats')

    expect(texts(tree)).toContain(named)
    expect(texts(tree)).toContain('order 42')
    expect(drawnOutsideFold(tree)).not.toContain(LNURL)
    const fold = tree.root.findByType(DetailsFold)
    expect(fold.props.label).toBe(i18n.t('send.details'))
    await ReactTestRenderer.act(async () => fold.findAll(n => typeof n.props.onPress === 'function')[0].props.onPress())
    expect(tree.root.findByType(DetailsFold).findAllByType(ChunkedAddress)[0].props.value).toBe(LNURL)
  })

  test("with no address or domain the service's own words name it", async () => {
    const tree = await toLnurl({ payee: '', description: 'Coffee at Ana' })
    const named = i18n.t('send.payAddress', { name: 'Coffee at Ana' })
    expect(sheet(tree).props.title).toBe(named)
    await typeAmount(tree, 5000, 'sats')
    expect(texts(tree)).toContain(named)
  })

  test('a lightning address names itself on the keypad and stays the card the review draws', async () => {
    const tree = await toLnurl({ payee: 'alice@example.com' }, 'lightningAddress', 'alice@example.com')
    expect(sheet(tree).props.title).toBe(i18n.t('send.payAddress', { name: 'alice@example.com' }))
    await typeAmount(tree, 5000, 'sats')
    expect(drawnOutsideFold(tree)).toContain('alice@example.com')
    expect(tree.root.findAllByType(DetailsFold)).toHaveLength(0)
  })

  test('a destination with no one to name keeps the plain title', async () => {
    const tree = await render()
    await paste(tree, ADDRESS)
    expect(sheet(tree).props.title).toBeUndefined()
  })
})

describe('lnurlText', () => {
  test('reads the text/plain entry of LUD-06 metadata', () => {
    expect(lnurlText('[["text/identifier","a@b.c"],["text/plain"," Coffee at Ana "]]')).toBe('Coffee at Ana')
  })

  test.each([
    ['not JSON', 'nope'],
    ['not an array', '{"text/plain":"x"}'],
    ['no text/plain', '[["image/png;base64","AAA"]]'],
    ['blank text', '[["text/plain","   "]]'],
    ['text that is not a string', '[["text/plain",5]]'],
  ])('answers nothing for %s', (_name, metadata) => {
    expect(lnurlText(metadata)).toBeUndefined()
  })
})

describe('an on-chain amount is held to the dust limit of its address', () => {
  const LEGACY = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT'
  const minLine = (sat: number) =>
    i18n.t('receive.belowMin', { min: i18n.t('receive.limitSats', { count: sat, amount: formatSats(sat) }) })

  test.each([
    [LEGACY, 546],
    ['3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 540],
    [ADDRESS, 294],
    ['bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297', 330],
  ])('the keypad states the minimum for %s before an amount is typed', async (address, dust) => {
    const tree = await render()
    await paste(tree, address)

    expect(sheet(tree).props.min).toBe(dust)
    expect(texts(tree)).toContain(i18n.t('receive.minHint', { min: i18n.t('receive.limitSats', { count: dust, amount: formatSats(dust) }) }))
  })

  test('the keypad refuses an amount under it', async () => {
    const tree = await render()
    await paste(tree, LEGACY)
    for (const key of ['3', '0', '0', i18n.t('receive.confirmAmount')]) {
      const target = sheet(tree)
        .findAll(n => typeof n.props.onPress === 'function')
        .find(n => n.findAllByType(Text).some(txt => txt.props.children === key))
      await ReactTestRenderer.act(async () => target?.props.onPress())
    }
    await settle()

    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(minLine(546))
  })

  test('an amount the code named under it reaches a review whose Confirm stays off', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress', resolved: LEGACY, requestedAmount: 300 })
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchainQuote(300))
    const tree = await render()
    await paste(tree, `bitcoin:${LEGACY}?amount=0.000003`)

    expect(confirmButton(tree)?.props.disabled).toBe(true)
    expect(texts(tree)).toContain(minLine(546))
  })

  test('at the limit Confirm is on', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bitcoinAddress', resolved: LEGACY, requestedAmount: 546 })
    jest.mocked(sparkPrepareSend).mockResolvedValue(onchainQuote(546))
    const tree = await render()
    await paste(tree, `bitcoin:${LEGACY}?amount=0.00000546`)

    expect(confirmButton(tree)?.props.disabled).toBe(false)
    expect(texts(tree)).not.toContain(minLine(546))
  })

  test('a Lightning destination gets no such minimum', async () => {
    const spark = jest.requireMock('../src/wallet/spark')
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'lightningAddress' })
    spark.sparkParseLnurlPay.mockResolvedValue({ handle: 'l1', minSat: 1, maxSat: 1_000_000, commentAllowed: 0, payee: 'alice@example.com' })
    const tree = await render()
    await paste(tree, 'alice@example.com')

    expect(sheet(tree).props.min).toBe(1)
  })
})

describe('the asset Send was opened on holds through the first destination', () => {
  const WITH_USDB = {
    sync: 'synced' as const,
    recoverableSat: 0,
    balanceSat: 100_000,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: USDB.decimals, balanceBaseUnits: 25_000_000 },
    ],
  }
  const moved = i18n.t('send.assetMoved', { ticker: USDB.ticker })
  const assetRow = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => String(node.props.label ?? '').endsWith(i18n.t('send.chooseAsset')))
  const onUsdbScreen = async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(WITH_USDB)
    mockRouteParams = { assetId: USDB.identifier }
    return render()
  }

  test('a Spark address keeps it, and the keypad asks in it', async () => {
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })
    const tree = await onUsdbScreen()
    await paste(tree, 'spark1bare')

    expect(texts(tree)).toContain(USDB.ticker)
    expect(pressable(tree, i18n.t('send.amountToken', { ticker: USDB.ticker }))).toBeDefined()
    expect(texts(tree)).not.toContain(moved)
    expect(assetRow(tree)).toBeDefined()
  })

  test('an on-chain address cannot carry it, so it goes in bitcoin and says so', async () => {
    const tree = await onUsdbScreen()
    await paste(tree, ADDRESS)

    expect(texts(tree)).toContain(moved)
    expect(sheet(tree).props.unit).toBe('sats')
    await typeAmount(tree, 20_000, 'sats')
    expect(sparkPrepareSend).toHaveBeenLastCalledWith(ADDRESS, 20_000, undefined)
    expect(texts(tree)).toContain(moved)
  })

  test('a destination after the first starts from bitcoin, as before', async () => {
    const tree = await onUsdbScreen()
    await paste(tree, ADDRESS)
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'sparkAddress' })

    await paste(tree, 'spark1bare')

    expect(texts(tree)).not.toContain(moved)
    expect(pressable(tree, i18n.t('send.amountToken', { ticker: USDB.ticker }))).toBeUndefined()
    expect(texts(tree)).toContain(i18n.t('send.assetBitcoin'))
  })

  test('a dollar wallet funds a Lightning send from USDB anyway, so nothing is said', async () => {
    mockDollarMode = true
    jest.mocked(sparkInspectDestination).mockResolvedValue({ kind: 'bolt11' })
    jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h1', amount: 1000, fee: 5 })
    const tree = await onUsdbScreen()
    await paste(tree, 'lnbc1invoice')

    expect(texts(tree)).not.toContain(moved)
  })
})

describe('carriesToken', () => {
  test.each([
    [{ kind: 'sparkAddress' as const }, true],
    [{ kind: 'sparkAddress' as const, tokenIdentifier: USDB.identifier }, true],
    [{ kind: 'sparkAddress' as const, tokenIdentifier: 'btkn1other' }, false],
    [{ kind: 'sparkAddress' as const, amount: 1000 }, false],
    [{ kind: 'sparkAddress' as const, requestedAmount: 1000 }, false],
    [{ kind: 'bolt11' as const }, false],
    [{ kind: 'bitcoinAddress' as const }, false],
    [{ kind: 'lightningAddress' as const }, false],
  ])('%o carries USDB: %s', (info, expected) => {
    expect(carriesToken(info, USDB.identifier)).toBe(expected)
  })
})

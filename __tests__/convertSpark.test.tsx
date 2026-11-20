import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, Dimensions, ScrollView, StyleSheet, Text } from 'react-native'
import i18n from '../src/i18n'
import { SpendHeldByExit } from '../src/wallet/errors'
import { ConvertSpark } from '../src/screens/ConvertSpark'
import { AmountSheet } from '../src/components/AmountSheet'
import { FigureRow } from '../src/components/FigureRow'
import { Sheet } from '../src/components/Sheet'
import { Txt } from '../src/components/Txt'
import { AssetIcon } from '../src/components/AssetIcon'
import { figuresHeldOut, figuresIn, hostParent, textOf } from './support/figureFit'
import { markedInOpenPicker } from './support/pickerMark'
import { colors, touch } from '../src/theme'
import {
  sparkGetWalletInfo,
  sparkGetFiatRates,
  sparkPrepareConvert,
  sparkPrepareConvertBySpend,
  sparkConfirmConvert,
  sparkConfirmConvertLeg,
  sparkConversionLimits,
  sparkDiscardConvertQuote,
  sparkGetStableBalance,
  sparkListFiatCurrencies,
} from '../src/wallet/spark'
import { KNOWN_SPARK_TOKENS, SPARK_BTC, formatPairRate } from '../src/wallet/sparkConvert'
import { AssetPickerSheet } from '../src/components/AssetPickerSheet'
import { ReceivedOverlay } from '../src/components/ReceivedOverlay'
import { addToken } from '../src/wallet/tokenPrefs'
import { DEPIX, USDB } from '../src/wallet/tokens'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'
import { saveDisplayCurrency } from '../src/wallet/settings'
import RNFS from 'react-native-fs'
import { getCurrencies } from 'react-native-localize'

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
const mockSynced = new Set<() => void>()
jest.mock('../src/wallet/spark', () => ({
  onSparkConnected: () => () => undefined,
  onSparkSynced: (cb: () => void) => {
    mockSynced.add(cb)
    return () => mockSynced.delete(cb)
  },
  sparkSyncWaitLeftMs: () => 0,
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkPrepareConvert: jest.fn(),
  sparkPrepareConvertBySpend: jest.fn(),
  sparkConfirmConvert: jest.fn(),
  sparkConfirmConvertLeg: jest.fn(),
  sparkDiscardConvertQuote: jest.fn(),
  sparkConversionLimits: jest.fn(async () => ({})),
  sparkGetStableBalance: jest.fn(async () => false),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ConvertSpark />)
  })
  return tree
}

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
  })
}

// The cards quote on a debounce, so the timer has to run before Convert enables.
async function settleQuote(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(500)
  })
}

async function pressBtn(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    btn.props.onPress()
  })
  await flush()
}

// Sats arrive through AmountSheet.onConfirm. A token's sheet hands on the base units typed, so its
// figure goes in through the keypad, as typed.
async function enterSide(
  tree: ReactTestRenderer.ReactTestRenderer,
  side: 'Send' | 'Receive',
  value: number | string,
): Promise<void> {
  const trigger = tree.root
    .findAll(n => n.props.accessibilityLabel === side && typeof n.props.onPress === 'function')
    .at(-1)
  await ReactTestRenderer.act(async () => {
    trigger?.props.onPress()
  })
  const sheet = tree.root.findByType(AmountSheet)
  if (!sheet.props.tokenBounds) {
    await ReactTestRenderer.act(async () => {
      sheet.props.onConfirm(value)
    })
    return
  }
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
}

async function enterReceive(tree: ReactTestRenderer.ReactTestRenderer, value: number | string): Promise<void> {
  await enterSide(tree, 'Receive', value)
}

async function enterSend(tree: ReactTestRenderer.ReactTestRenderer, value: number | string): Promise<void> {
  await enterSide(tree, 'Send', value)
}

function textStrings(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(n => {
    const c = n.props.children
    return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === 'string')
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getCurrencies).mockReturnValue(STOCK_DEVICE_CURRENCIES)
  jest.useFakeTimers()
  // With no held tokens the To side falls back to USDB, the only known token.
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 0, tokens: [] })
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000, BRL: 550_000 })
  jest.mocked(sparkPrepareConvert).mockResolvedValue({
    handle: 'h1',
    spentBaseUnits: 210_000,
    receivedBaseUnits: 10_000_000,
    feeBaseUnits: 500,
  })
  jest.mocked(sparkConfirmConvert).mockResolvedValue('complete')
})

afterEach(() => {
  jest.useRealTimers()
})

test('the receive side waits for the assets, since bitcoin on both sides is no conversion', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<ConvertSpark />)
  })
  const marks = () => tree.root.findAllByType(AssetIcon).length
  expect(marks()).toBe(1)
  await flush()
  await flush()
  expect(marks()).toBe(2)
})

test('an empty side says the amount is a tap away, and a filled one stops saying it', async () => {
  const tree = await render()
  await flush()
  const shown = () => tree.root.findAllByType(Text).filter(n => n.props.children === i18n.t('convert.tapToEnter'))
  expect(shown()).toHaveLength(2)

  await enterReceive(tree, 10)
  expect(shown().length).toBeLessThan(2)
})

test('the words that say to tap open the amount, as the figure above them does', async () => {
  const tree = await render()
  await flush()

  await pressBtn(tree, i18n.t('convert.tapToEnter'))

  expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
})

test('the line under a filled amount answers no tap', async () => {
  const tree = await render()
  await flush()
  await enterReceive(tree, 10)
  await settleQuote()

  const invitations = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
    .filter(n => n.findAllByType(Text).some(t => String(t.props.children).startsWith('≈')))
  expect(invitations).toHaveLength(0)
})

test('the review writes sats one way on every line, with the app\'s spaces', async () => {
  jest.mocked(sparkPrepareConvert).mockResolvedValue({
    handle: 'h2',
    spentBaseUnits: 1_000,
    receivedBaseUnits: 1_000_000,
    feeBaseUnits: 0,
  })
  const tree = await render()
  await flush()
  await enterReceive(tree, 1)
  await settleQuote()
  await pressBtn(tree, 'Convert')

  const shown = textStrings(tree)
  expect(shown).toContain('1\u00a0000 sats')
  expect(shown).toContain('1 USDB = 1\u00a0000 sats')
  expect(shown.join(' ')).not.toContain('1,000')
})

// A known minimum with no balance has nothing to say, and the 8pt of an empty line moved the swap
// button each time the quote came and went.
describe('the line between the card and the swap button', () => {
  const limitsLines = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(
      n => typeof n.type === 'string' && StyleSheet.flatten(n.props.style)?.minHeight === 24,
    )

  afterEach(() => {
    jest.mocked(sparkConversionLimits).mockResolvedValue({})
  })

  test('a minimum known with no balance draws no line', async () => {
    jest.mocked(sparkConversionLimits).mockResolvedValue({ minFromBaseUnits: 800 })
    const tree = await render()
    await flush()

    expect(limitsLines(tree)).toHaveLength(0)
  })

  test.each([
    ['a price', { USD: 100_000, BRL: 550_000 }],
    ['no price', {}],
  ])('a balance holds the line with %s, chips or none', async (_, rates) => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue(rates)
    jest
      .mocked(sparkGetWalletInfo)
      .mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 5_000, tokens: [] })
    const tree = await render()
    await flush()

    expect(limitsLines(tree)).toHaveLength(1)
  })
})

test('receive-driven: the live quote prepares the desired token output and drives the review', async () => {
  const tree = await render()
  await flush()

  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')

  // USDB carries 6 decimals, so 10 USDB is 10_000_000 base units.
  expect(sparkPrepareConvert).toHaveBeenCalledWith(undefined, KNOWN_SPARK_TOKENS[0].id, 10_000_000n)
})

test('the review shows the effective cost, never the SDK fee field', async () => {
  // feeBaseUnits can report far more than a convert costs, so the review computes the effective
  // cost from the amounts instead of trusting that field.
  jest.mocked(sparkPrepareConvert).mockResolvedValue({
    handle: 'h2',
    spentBaseUnits: 210_000,
    receivedBaseUnits: 207_900_000,
    feeBaseUnits: 99_999,
  })
  const tree = await render()
  await flush()

  await enterReceive(tree, 207.9)
  await settleQuote()
  await pressBtn(tree, 'Convert')

  const shown = tree.root.findAllByType(Text).flatMap(n => {
    const c = n.props.children
    return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === 'string')
  })
  expect(shown.some(s => s.includes('%'))).toBe(true)
  expect(shown.join(' ')).not.toContain('99999')
  expect(shown.some(s => s.includes('USDB =') && s.includes('sats'))).toBe(true)
})

// The unit word comes from the locale with the figure, never as a literal beside it.
test('the review rate in sats is written through the locale', async () => {
  jest.mocked(sparkPrepareConvert).mockResolvedValue({
    handle: 'h2',
    spentBaseUnits: 210_000,
    receivedBaseUnits: 207_900_000,
    feeBaseUnits: 0,
  })
  i18n.addResource(i18n.language, 'translation', 'convert.rateSats', '{{ticker}} at {{amount}} satoshis')
  try {
    const tree = await render()
    await flush()
    await enterReceive(tree, 207.9)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    const shown = tree.root.findAllByType(Text).flatMap(n => {
      const c = n.props.children
      return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === 'string')
    })
    expect(shown.some(s => /^USDB at .+ satoshis$/.test(s))).toBe(true)
  } finally {
    i18n.addResource(i18n.language, 'translation', 'convert.rateSats', '1 {{ticker}} = {{amount}} sats')
  }
})

test('send-driven: the card shows the executed spend, not the typed amount (card == review)', async () => {
  // Whole-output rounding executes an 800 sat spend at 797, and a card showing 800 would contradict
  // the review, which reads the same quote.
  jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue({
    handle: 'hs',
    spentBaseUnits: 797,
    receivedBaseUnits: 640_000,
    feeBaseUnits: 0,
  })
  const tree = await render()
  await flush()

  await enterSend(tree, 800)
  await settleQuote()

  const cards = textStrings(tree)
  expect(cards).toContain('797')
  expect(cards).not.toContain('800')

  await pressBtn(tree, 'Convert')
  expect(textStrings(tree).some(s => s.includes('797'))).toBe(true)
})

// 100 USDB at 100 000 USD a bitcoin, from a pool that costs 0.4% with 1% of slippage allowed, so the
// quote receives its floor of 98 604 sats.
test('USDB into sats states the pool cost, never the slippage allowed', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 0,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 100_000_000 },
    ],
  })
  jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue({
    handle: 'hf',
    spentBaseUnits: 100_000_000,
    receivedBaseUnits: 98_604,
    expectedBaseUnits: 99_600,
    feeBaseUnits: 0,
  })
  const tree = await render()
  await flush()
  const sendCard = () => tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)[0]!
  await ReactTestRenderer.act(async () => sendCard().props.onPickAsset())
  await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(USDB.identifier))

  await enterSend(tree, 100)
  await settleQuote()
  await pressBtn(tree, 'Convert')

  expect(textStrings(tree)).toContain(i18n.t('convert.feeApprox', { pct: '0.4' }))
})

test('confirms the prepared conversion through its handle', async () => {
  const tree = await render()
  await flush()

  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  await pressBtn(tree, 'Confirm conversion')

  expect(sparkConfirmConvert).toHaveBeenCalledWith('h1')
  // The call resolving means the swap was accepted, not that the other asset arrived: it lands as a
  // separate Spark transfer tens of seconds later. So the screen holds rather than celebrating, and
  // the form is still there. Celebrating here would show the success over the old balance and then
  // leave that old number on screen, which reads as a failure and invites a second attempt on a path
  // that moves money.
  const hasConvert = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .some(n => n.findAllByType(Text).some(t => t.props.children === 'Convert'))
  expect(hasConvert).toBe(true)
})

// A conversion with no end yet is drawn with the clock, never called converted, and points at the
// balance, since no record follows it to tell its end.
test.each([
  ['pending', 'convert.onTheWay', 'convert.pendingLine'],
  ['complete', 'convert.done', undefined],
] as const)('a conversion the SDK calls %s is drawn as such', async (status, label, line) => {
  jest.mocked(sparkConfirmConvert).mockImplementation(async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [
        { identifier: KNOWN_SPARK_TOKENS[0]!.id, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
      ],
    })
    return status
  })
  const tree = await render()
  await flush()
  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  await pressBtn(tree, 'Confirm conversion')
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(2100)
  })

  const overlay = tree.root.findByType(ReceivedOverlay)
  expect(overlay.props.label).toBe(i18n.t(label))
  expect(overlay.props.pending).toBe(line === undefined ? undefined : i18n.t(line))
})

// The amounts belong to the conversion that just ran; left in place they read as a second one waiting,
// behind a disabled button, once the balance they came from is spent.
test('closing the success starts an empty form', async () => {
  jest.mocked(sparkConfirmConvert).mockImplementation(async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [
        { identifier: KNOWN_SPARK_TOKENS[0]!.id, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, balanceBaseUnits: 10_000_000 },
      ],
    })
    return 'complete'
  })
  const tree = await render()
  await flush()
  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  await pressBtn(tree, 'Confirm conversion')
  // The success waits for the balance, which is first read after one settle delay.
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(2100)
  })

  const overlay = tree.root.findByType(ReceivedOverlay)
  await ReactTestRenderer.act(async () => overlay.props.onDone())

  const values = tree.root
    .findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)
    .map(card => card.props.value)
  expect(values).toEqual(['', ''])
})

// With the mode on the SDK sweeps loose sats back into USDB, so a leg into bitcoin would cost its fee
// and leave nothing in bitcoin. The context can lag the SDK, which is why the confirm asks it.
describe('a token into bitcoin, on the SDK\'s answer', () => {
  const NEEDS_BITCOIN =
    'With the dollar wallet on, a token can only be converted into dollars, because the bitcoin in between would turn back into dollars.'

  afterEach(() => {
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
  })

  async function underReview(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 5_000,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 10_000_000 },
      ],
    })
    const tree = await render()
    await flush()
    const send = tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)[0]!
    await ReactTestRenderer.act(async () => send.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(USDB.identifier))
    await enterReceive(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    return tree
  }

  test('the leg runs when the SDK says the mode is off', async () => {
    const tree = await underReview()
    jest.mocked(sparkGetStableBalance).mockClear()
    await pressBtn(tree, 'Confirm conversion')

    expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)
    expect(sparkConfirmConvert).toHaveBeenCalledWith('h1')
  })

  test('the mode on at the SDK, off in the context: the leg does not run and the screen says why', async () => {
    const tree = await underReview()
    jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
    await pressBtn(tree, 'Confirm conversion')

    expect(sparkConfirmConvert).not.toHaveBeenCalled()
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('h1')
    expect(textStrings(tree)).toContain(NEEDS_BITCOIN)
    expect(tree.root.findAll(n => n.props.label === 'Confirm conversion')).toHaveLength(0)
  })

  test('a read that fails runs nothing, and offers Convert again on a fresh quote', async () => {
    const tree = await underReview()
    jest.mocked(sparkGetStableBalance).mockRejectedValue(new Error('network'))
    await pressBtn(tree, 'Confirm conversion')
    await settleQuote()

    expect(sparkConfirmConvert).not.toHaveBeenCalled()
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('h1')
    expect(textStrings(tree)).toContain('Could not convert.')
    expect(textStrings(tree)).not.toContain(NEEDS_BITCOIN)
  })

  test('while the read is in flight the leg waits, a second press does nothing, and Cancel stays shut', async () => {
    const tree = await underReview()
    let answer: (on: boolean) => void = () => undefined
    jest.mocked(sparkGetStableBalance).mockReturnValue(new Promise(resolve => (answer = resolve)))
    jest.mocked(sparkGetStableBalance).mockClear()
    await pressBtn(tree, 'Confirm conversion')
    await pressBtn(tree, 'Confirm conversion')
    await pressBtn(tree, 'Cancel')
    await settleQuote()

    expect(sparkConfirmConvert).not.toHaveBeenCalled()
    expect(sparkDiscardConvertQuote).not.toHaveBeenCalled()
    expect(sparkGetStableBalance).toHaveBeenCalledTimes(1)

    await ReactTestRenderer.act(async () => answer(false))
    await flush()

    expect(sparkConfirmConvert).toHaveBeenCalledTimes(1)
  })
})

test('sats into a token ask nothing, since nothing is left loose', async () => {
  const tree = await render()
  await flush()
  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  jest.mocked(sparkGetStableBalance).mockClear()
  jest.mocked(sparkGetStableBalance).mockRejectedValueOnce(new Error('network'))
  await pressBtn(tree, 'Confirm conversion')

  expect(sparkGetStableBalance).not.toHaveBeenCalled()
  expect(sparkConfirmConvert).toHaveBeenCalledWith('h1')
  jest.mocked(sparkGetStableBalance).mockReset().mockResolvedValue(false)
})

// Cancel drops the prepared quote, and the amounts stay on the cards, so without a fresh quote they
// sit behind a disabled Convert until something is retyped.
test.each(['the Cancel button', 'closing the sheet'])(
  'cancelling the review by %s quotes the same amounts again, so Convert works without retyping',
  async how => {
    const tree = await render()
    await flush()
    await enterReceive(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    jest.mocked(sparkPrepareConvert).mockClear()

    if (how === 'the Cancel button') {
      await pressBtn(tree, 'Cancel')
    } else {
      const sheet = tree.root.findAll(n => n.props.closeLabel === 'Cancel' && typeof n.props.onClose === 'function')[0]!
      await ReactTestRenderer.act(async () => sheet.props.onClose())
    }
    await settleQuote()

    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('h1')
    expect(sparkPrepareConvert).toHaveBeenCalledTimes(1)
    const convert = tree.root.findAll(n => n.props.label === 'Convert' && 'disabled' in n.props)[0]!
    expect(convert.props.disabled).toBe(false)
  },
)

test('a failed conversion surfaces the error inline instead of returning silently', async () => {
  // A failed conversion resolves as a status rather than throwing, which makes it easy to swallow.
  jest.mocked(sparkConfirmConvert).mockResolvedValue('failed')
  const tree = await render()
  await flush()

  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  await pressBtn(tree, 'Confirm conversion')

  const shown = tree.root.findAllByType(Text).some(n => n.props.children === 'Could not convert.')
  expect(shown).toBe(true)
})

// spark.ts refuses a conversion while an exit holds the wallet, and the screen says so in Send's words.
test.each([
  ['exit', 'emergencyExit.spendHeld'],
  ['unread', 'emergencyExit.spendHeldUnread'],
] as const)('a conversion an exit holds (%s) says why, not that it failed', async (hold, key) => {
  jest.mocked(sparkConfirmConvert).mockRejectedValueOnce(new SpendHeldByExit(hold))
  const tree = await render()
  await flush()

  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  await pressBtn(tree, 'Confirm conversion')

  const texts = tree.root.findAllByType(Text).map(n => n.props.children)
  expect(texts).toContain(i18n.t(key))
  expect(texts).not.toContain('Could not convert.')
})

// Nothing moved and the handle is spent, so the amounts stay and Convert comes back on a new quote.
test('after a failed conversion Convert is offered again, on a fresh quote for the same amounts', async () => {
  jest.mocked(sparkConfirmConvert).mockResolvedValueOnce('failed')
  const tree = await render()
  await flush()

  await enterReceive(tree, 10)
  await settleQuote()
  await pressBtn(tree, 'Convert')
  const quotes = jest.mocked(sparkPrepareConvert).mock.calls.length
  await pressBtn(tree, 'Confirm conversion')
  await settleQuote()

  expect(jest.mocked(sparkPrepareConvert).mock.calls.length).toBe(quotes + 1)
  expect(jest.mocked(sparkPrepareConvert).mock.calls.at(-1)).toEqual(jest.mocked(sparkPrepareConvert).mock.calls.at(-2))
  const convert = tree.root.findAll(n => n.props.label === 'Convert' && 'disabled' in n.props)[0]
  expect(convert?.props.disabled).toBe(false)
  expect(tree.root.findAllByType(Text).some(n => n.props.children === 'Could not convert.')).toBe(true)

  jest.mocked(sparkConfirmConvert).mockResolvedValueOnce('complete')
  await pressBtn(tree, 'Convert')
  await pressBtn(tree, 'Confirm conversion')
  expect(sparkConfirmConvert).toHaveBeenCalledTimes(2)
})

test('the waiting zero is not the same as a typed one', async () => {
  // Both fields read "0" before anything is entered. If the placeholder draws in the same colour as
  // a real value, there is no way to tell an untouched field from one holding zero, and this screen
  // has two of them side by side.
  const tree = await render()
  const zeroStyle = () => {
    const node = tree.root.findAllByType(Text).find(n => n.props.children === '0')!
    return Object.assign(
      {},
      ...[node.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
    )
  }
  expect(zeroStyle().color).toBe(colors.textSecondary)

  await enterSend(tree, 21_000)
  const typed = tree.root.findAllByType(Text).find(n => String(n.props.children).includes('21'))!
  const style = Object.assign(
    {},
    ...[typed.props.style].flat(Infinity).filter(x => x && typeof x === 'object'),
  )
  expect(style.color).toBe(colors.text)
})

describe('display currency', () => {
  // A device in Brazil, so the region default (BRL) and the choices below differ. Rates put 2,000 sats
  // at US$ 2.00, R$ 11.00 and € 1.80, so each currency draws a figure of its own. Only the coins asked
  // for are answered, as sparkGetFiatRates does.
  const RATES: Record<string, number> = { USD: 100_000, BRL: 550_000, EUR: 90_000 }
  beforeEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
  })
  afterEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
  })

  async function fiatLines(): Promise<string[]> {
    const tree = await render()
    await flush()
    await enterSend(tree, 2000)
    await flush()
    return textStrings(tree).filter(s => s.startsWith('≈ '))
  }

  test('both cards price in the currency chosen in Settings, not the device region', async () => {
    await saveDisplayCurrency('USD')

    const lines = await fiatLines()

    expect(lines).toEqual(['≈ $2.00', '≈ $2.00'])
  })

  // No peg is in euros, so the rate is there only when the screen asks for the chosen currency, and
  // the symbol only when the SDK's list has configured the formatter.
  test('a chosen currency beyond the pegs gets its rate and its symbol', async () => {
    jest
      .mocked(sparkListFiatCurrencies)
      .mockResolvedValue([{ id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }])
    await saveDisplayCurrency('EUR')

    const lines = await fiatLines()

    expect(lines).toEqual(['≈ €1.80', '≈ €1.80'])
  })

  test('with nothing chosen the cards price in the device region currency', async () => {
    const lines = await fiatLines()

    expect(lines).toEqual(['≈ R$11.00', '≈ R$11.00'])
  })
})

describe('DePix', () => {
  // Answers only the coins asked for, as sparkGetFiatRates does, so a convert that never asks for the
  // real cannot price DePix.
  const RATES: Record<string, number> = { USD: 100_000, BRL: 500_000 }
  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    // Token lists belong to the wallet in front.
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/wallets.json`, JSON.stringify({ active: 'w_test', wallets: [{ id: 'w_test', fingerprint: 'fp-test' }] }), 'utf8')
    await addToken({ identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals })
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
    jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue({
      handle: 'hd',
      spentBaseUnits: 100_000,
      receivedBaseUnits: 49_500_000_000,
      feeBaseUnits: 0,
    })
  })
  afterEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
  })

  async function chooseReceive(tree: ReactTestRenderer.ReactTestRenderer, id: string): Promise<void> {
    const recvCard = tree.root.findAll(n => 'onPickAsset' in n.props).at(-1)!
    await ReactTestRenderer.act(async () => recvCard.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(id))
  }

  // 100_000 sats is 500 reais at 500_000 BRL per bitcoin, so the search starts at 500 DePix and not
  // at 100_000 base units, which would be a thousandth of a real.
  test('an added DePix is a destination, and the spend search starts from its price in reais', async () => {
    const tree = await render()
    await flush()
    const items = tree.root.findByType(AssetPickerSheet).props.items.map((i: { assetId: string }) => i.assetId)
    expect(items).toContain(DEPIX.identifier)

    await chooseReceive(tree, DEPIX.identifier)
    await enterSend(tree, 100_000)
    await settleQuote()

    expect(sparkPrepareConvertBySpend).toHaveBeenCalledWith(undefined, DEPIX.identifier, 100_000, 50_000_000_000)
  })

  test('the review reads a DePix convert cost against the real', async () => {
    const tree = await render()
    await flush()
    await chooseReceive(tree, DEPIX.identifier)
    await enterSend(tree, 100_000)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    // 495 DePix for 500 reais of bitcoin is a 1% cost.
    const shown = textStrings(tree)
    expect(shown.some(text => /1([.,]0+)?\s?%/.test(text))).toBe(true)
  })
})

// A spend of sats into a token is searched from the token's price. Without it the only seed left would
// be the sats read as the token's base units, which starts the search orders of magnitude off.
describe('a spend of sats into a token with no price for it', () => {
  const sendCard = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)[0]!
  const hasButton = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .some(n => n.findAllByType(Text).some(t => t.props.children === label))

  test.each([
    ['no price', {}, false],
    ['a price', { USD: 100_000, BRL: 550_000 }, true],
  ])('with %s for the token, the spend field and Max follow it', async (_, rates, offered) => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue(rates)
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 5_000, tokens: [] })
    const tree = await render()
    await flush()

    expect(sendCard(tree).props.asset.id).toBe(SPARK_BTC.id)
    expect(sendCard(tree).props.editable).toBe(offered)
    expect(sendCard(tree).props.note).toBe(offered ? undefined : 'Rate unavailable')
    expect(hasButton(tree, 'Max')).toBe(offered)
  })

  // A swap carries a typed receive of sats over as the spend, which asks for nothing here.
  test('a spend carried over by a swap asks for no quote', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const tree = await render()
    await flush()
    const swap = async () => {
      const button = tree.root.findAll(
        n => n.props.accessibilityLabel === 'Swap direction' && typeof n.props.onPress === 'function',
      )[0]!
      await ReactTestRenderer.act(async () => button.props.onPress())
    }
    await swap()
    await enterReceive(tree, 1_000)
    await settleQuote()
    await swap()
    await settleQuote()

    expect(sendCard(tree).props.asset.id).toBe(SPARK_BTC.id)
    expect(sendCard(tree).props.value).toBe('1000')
    expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
    expect(textStrings(tree)).not.toContain('Could not quote this conversion.')
  })

  // The receive is quoted by its exact output, which needs no price.
  test('the receive is still quoted', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const tree = await render()
    await flush()
    await enterReceive(tree, 10)
    await settleQuote()

    expect(sparkPrepareConvert).toHaveBeenCalledWith(undefined, USDB.identifier, 10_000_000n)
  })
})

describe('the balance before the first sync', () => {
  const held = (sync: 'synced' | 'waiting' | 'stale') => ({
    sync,
    recoverableSat: 0,
    balanceSat: 5_000,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 1_000_000 },
    ],
  })
  const cards = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)
  const hasButton = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .some(n => n.findAllByType(Text).some(t => t.props.children === label))
  async function sendSubtitles(tree: ReactTestRenderer.ReactTestRenderer): Promise<(string | undefined)[]> {
    const sendCard = tree.root.findAll(n => 'onPickAsset' in n.props)[0]!
    await ReactTestRenderer.act(async () => sendCard.props.onPickAsset())
    return tree.root
      .findByType(AssetPickerSheet)
      .props.items.map((i: { subtitle?: string }) => i.subtitle)
  }

  test('a read before the sync offers no Max and no amounts in the picker', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(held('waiting'))
    const tree = await render()
    await flush()

    expect(hasButton(tree, 'Max')).toBe(false)
    expect(await sendSubtitles(tree)).toEqual([undefined, undefined])
  })

  test('past the wait the stored balance is still not offered as spendable', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(held('stale'))
    const tree = await render()
    await flush()

    expect(hasButton(tree, 'Max')).toBe(false)
  })

  test('the sync brings Max and the amounts, and keeps the sides', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(held('waiting'))
    const tree = await render()
    await flush()
    const sides = () => cards(tree).map(card => card.props.asset.id)
    const before = sides()

    jest.mocked(sparkGetWalletInfo).mockResolvedValue(held('synced'))
    await ReactTestRenderer.act(async () => {
      mockSynced.forEach(cb => cb())
    })
    await flush()

    expect(hasButton(tree, 'Max')).toBe(true)
    expect(sides()).toEqual(before)
    expect((await sendSubtitles(tree)).every(sub => typeof sub === 'string')).toBe(true)
  })
})

// The keypad on the send side is what Send's is: past the balance it says so and Confirm does nothing,
// so an amount the wallet cannot spend never reaches a quote and Convert never stands ready for it.
describe('the amount sheet weighs the send side against the balance', () => {
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AmountSheet)
  async function open(tree: ReactTestRenderer.ReactTestRenderer, side: 'Send' | 'Receive'): Promise<void> {
    const trigger = tree.root
      .findAll(n => n.props.accessibilityLabel === side && typeof n.props.onPress === 'function')
      .at(-1)
    await ReactTestRenderer.act(async () => trigger?.props.onPress())
  }
  async function key(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
    const target = sheet(tree)
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(t => t.props.children === label))
    if (!target) {
      throw new Error(`key not found: ${label}`)
    }
    await ReactTestRenderer.act(async () => target.props.onPress())
  }

  test('with nothing held, 50 000 sats typed says so and cannot be confirmed', async () => {
    const tree = await render()
    await flush()
    await open(tree, 'Send')
    expect(sheet(tree).props.available).toBe(0)

    for (const digit of '50000') {
      await key(tree, digit)
    }
    expect(textStrings(tree)).toContain(i18n.t('errors.insufficientFunds'))
    await key(tree, i18n.t('receive.confirmAmount'))
    expect(sheet(tree).props.visible).toBe(true)
    await settleQuote()
    expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
  })

  test('a token balance is offered in the token, and the receive side is not weighed', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 5_000,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 2_500_000 },
      ],
    })
    const tree = await render()
    await flush()
    await open(tree, 'Send')
    expect(sheet(tree).props.available).toBe(5_000)
    await ReactTestRenderer.act(async () => sheet(tree).props.onClose())

    const swap = tree.root.find(n => n.props.label === i18n.t('convert.swap') && typeof n.props.onPress === 'function')
    await ReactTestRenderer.act(async () => swap.props.onPress())
    await open(tree, 'Send')
    expect(sheet(tree).props.unit).toBe('USDB')
    // Weighed in base units, so the balance reaches the sheet as held.
    expect(sheet(tree).props.tokenBounds.available).toBe(2_500_000n)
    expect(sheet(tree).props.available).toBeUndefined()
    await ReactTestRenderer.act(async () => sheet(tree).props.onClose())

    await open(tree, 'Receive')
    expect(sheet(tree).props.available).toBeUndefined()
  })

  test('a balance not read from a synced connection locks nothing', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'stale', recoverableSat: 0, balanceSat: 0, tokens: [] })
    const tree = await render()
    await flush()
    await open(tree, 'Send')

    expect(sheet(tree).props.available).toBeUndefined()
  })
})

// The picker keys a row's logo by its icon id; Bitcoin's asset id is 'btc', which no logo answers to.
test('the send list draws the Bitcoin mark, not a letter', async () => {
  // Two held assets, since a side with one choice is a fact and opens no list.
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 5_000,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 1_000_000 },
    ],
  })
  const tree = await render()
  await flush()
  const sendCard = tree.root.findAll(n => 'onPickAsset' in n.props)[0]!
  await ReactTestRenderer.act(async () => sendCard.props.onPickAsset())
  const btc = tree.root.findByType(AssetPickerSheet).props.items.find((i: { assetId: string }) => i.assetId === 'btc')
  expect(btc?.iconId).toBe(BITCOIN_ASSET_ID)
})

test('the bitcoin card is titled Bitcoin, and sats stays its unit', async () => {
  const tree = await render()
  await flush()
  const card = tree.root.findAll(
    n => 'onPickAsset' in n.props && n.props.asset?.id === 'btc',
  )[0]!
  const shown = card.findAllByType(Text).map(n => n.props.children)
  expect(shown).toContain('Bitcoin')
  expect(shown.filter(text => text === 'sats')).toHaveLength(1)
})

// A token's ticker is its unit, so it is named once, in the selector, where Bitcoin is named by its
// name and keeps sats as the unit under the amount.
test('a token card names its ticker once', async () => {
  const tree = await render()
  await flush()
  const card = tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset?.ticker === 'USDB')[0]!
  const shown = card.findAllByType(Text).map(n => n.props.children)
  expect(shown.filter(text => text === 'USDB')).toHaveLength(1)
})

// The label replaces what the selector shows, so it carries the asset as well as the action.
test('an asset selector a screen reader reaches names the asset and what the tap does', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 5_000,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 1_000_000 },
    ],
  })
  const tree = await render()
  await flush()
  const labels = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.accessibilityLabel === 'string')
    .map(n => n.props.accessibilityLabel as string)
  expect(labels).toContain(`Bitcoin, ${i18n.t('receive.chooseAsset')}`)
})

// Min and Max sit a gap apart, so a slop to the sides would lay one's target over the other.
test('Min and Max reach the touch floor up and down, never into each other', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 5_000,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 1_000_000 },
    ],
  })
  const tree = await render()
  await flush()
  const chip = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === 'Max'))!
  const slop = chip.props.hitSlop
  expect(slop.top).toBeGreaterThan(0)
  expect(slop.bottom).toBeGreaterThan(0)
  expect(slop.left ?? 0).toBe(0)
  expect(slop.right ?? 0).toBe(0)
})

// The send list opens on the asset the convert spends, and follows a new choice.
test('the send list marks the asset the convert spends, then the one picked', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 5_000,
    tokens: [
      { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 1_000_000 },
    ],
  })
  const tree = await render()
  await flush()
  const sendCard = () => tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)[0]!
  const spending = sendCard().props.asset.id
  await ReactTestRenderer.act(async () => sendCard().props.onPickAsset())
  expect(markedInOpenPicker(tree.root)).toEqual([spending])

  const other = spending === SPARK_BTC.id ? USDB.identifier : SPARK_BTC.id
  await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(other))
  expect(sendCard().props.asset.id).toBe(other)
  await ReactTestRenderer.act(async () => sendCard().props.onPickAsset())
  expect(markedInOpenPicker(tree.root)).toEqual([other])
})

// The SDK converts only between bitcoin and a token, so USDB to DePix runs as USDB to bitcoin and then
// bitcoin to DePix. At 100_000 USD and 500_000 BRL per bitcoin, 10 USDB is 10_000 sats and 50 DePix.
describe('USDB to DePix, through bitcoin', () => {
  const RATES: Record<string, number> = { USD: 100_000, BRL: 500_000 }
  // Each leg answers by its own direction, so a call routed the wrong way gets nothing to show.
  const LEG1 = { handle: 'leg1', spentBaseUnits: 10_000_000, receivedBaseUnits: 9_900, feeBaseUnits: 0 }
  const LEG2 = { handle: 'leg2', spentBaseUnits: 9_900, receivedBaseUnits: 4_900_000_000, feeBaseUnits: 0 }
  const LEG2_AGAIN = { handle: 'leg2b', spentBaseUnits: 9_950, receivedBaseUnits: 4_925_000_000, feeBaseUnits: 0 }

  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    mockDollarMode = false
    // Token lists belong to the wallet in front.
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/wallets.json`, JSON.stringify({ active: 'w_test', wallets: [{ id: 'w_test', fingerprint: 'fp-test' }] }), 'utf8')
    await addToken({ identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals })
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 50_000_000 },
      ],
    })
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
    jest.mocked(sparkPrepareConvertBySpend).mockImplementation(async (fromId, toId, spend) => {
      if (fromId === USDB.identifier && toId === undefined) {
        return LEG1
      }
      if (fromId === undefined && toId === DEPIX.identifier) {
        return spend === 9_950 ? LEG2_AGAIN : LEG2
      }
      throw new Error(`unexpected leg ${fromId} -> ${toId}`)
    })
    jest.mocked(sparkConfirmConvertLeg).mockResolvedValue({ status: 'complete', receivedBaseUnits: 9_950 })
    jest.mocked(sparkConfirmConvert).mockResolvedValue('complete')
  })
  afterEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    mockDollarMode = false
  })

  const cards = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)

  async function choose(tree: ReactTestRenderer.ReactTestRenderer, side: 0 | 1, id: string): Promise<void> {
    await ReactTestRenderer.act(async () => cards(tree)[side]!.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(id))
  }

  async function pair(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await flush()
    await choose(tree, 0, USDB.identifier)
    await choose(tree, 1, DEPIX.identifier)
    return tree
  }

  // The wallet after a leg ran: USDB spent on the first, sats spent on the second.
  const holding = (usdb: number, sats: number) =>
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: sats,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: usdb },
      ],
    })

  async function reviewAndConfirm(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    await pressBtn(tree, 'Confirm conversion')
  }

  // A pair spends what the first leg's floor promises, so its figures come out a point low with it.
  test('the cost of a pair reads what the first leg gives, not the floor it signs', async () => {
    jest.mocked(sparkPrepareConvertBySpend).mockImplementation(async (fromId, toId) =>
      fromId === USDB.identifier && toId === undefined
        ? { ...LEG1, receivedBaseUnits: 9_860, expectedBaseUnits: 9_960 }
        : { ...LEG2, spentBaseUnits: 9_860, receivedBaseUnits: 4_900_000_000 },
    )
    const tree = await pair()

    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    // 4 949.7 DePix for 10 USDB, against 5 000 at spot.
    expect(textStrings(tree)).toContain(i18n.t('convert.feeApprox', { pct: '1' }))
  })

  const STOPPED = 'The conversion stopped halfway. The value is in bitcoin in your wallet.'
  const CHECK = 'Could not confirm whether the conversion went through. Check your balance before trying again.'

  test('a token on each side stays, instead of the other side turning into bitcoin', async () => {
    const tree = await pair()
    expect(cards(tree).map(card => card.props.asset.id)).toEqual([USDB.identifier, DEPIX.identifier])
  })

  // The receive list opens on the asset the convert will deliver, and follows a new choice.
  test('the receive list marks the asset the convert delivers, then the one picked', async () => {
    const tree = await pair()
    await ReactTestRenderer.act(async () => cards(tree)[1]!.props.onPickAsset())
    expect(markedInOpenPicker(tree.root)).toEqual([DEPIX.identifier])
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(SPARK_BTC.id))
    await ReactTestRenderer.act(async () => cards(tree)[1]!.props.onPickAsset())
    expect(markedInOpenPicker(tree.root)).toEqual([SPARK_BTC.id])
    expect(cards(tree).map(card => card.props.asset.id)).toEqual([USDB.identifier, SPARK_BTC.id])
  })

  test('quotes USDB to bitcoin, then bitcoin to DePix on the sats the first leg gives', async () => {
    const tree = await pair()
    jest.mocked(sparkPrepareConvertBySpend).mockClear()
    await enterSend(tree, 10)
    await settleQuote()

    const calls = jest.mocked(sparkPrepareConvertBySpend).mock.calls
    expect(calls[0]).toEqual([USDB.identifier, undefined, 10_000_000n, 10_000])
    // 9_900 sats at 500_000 reais per bitcoin is 49.5 reais, so the search starts at 49.5 DePix.
    expect(calls[1]).toEqual([undefined, DEPIX.identifier, 9_900, 4_950_000_000])
    // A pair's minimum reads both legs, the first in USDB and the second in sats.
    expect(sparkConversionLimits).toHaveBeenCalledWith(USDB.identifier, undefined)
    expect(sparkConversionLimits).toHaveBeenCalledWith(undefined, DEPIX.identifier)
  })

  test('the review keeps its rows, with one fee for both legs', async () => {
    const tree = await pair()
    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    const shown = textStrings(tree)
    expect(shown).toContain('10 USDB')
    expect(shown).toContain('49 DePix')
    expect(shown).toContain('1 USDB = 4.90 DePix')
    // 10 USDB is 50 reais and 49 DePix is 49, so both legs together cost 2%.
    expect(shown).toContain('≈ 2%')
    expect(shown.filter(text => text === 'Fee')).toHaveLength(1)
  })

  test('confirming runs the first leg, then quotes and runs the second on the sats that arrived', async () => {
    const tree = await pair()
    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    await pressBtn(tree, 'Confirm conversion')

    expect(sparkConfirmConvertLeg).toHaveBeenCalledWith('leg1')
    // The review's second leg was sized on an estimate; 9_950 sats arrived, so it is quoted again.
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('leg2')
    expect(jest.mocked(sparkPrepareConvertBySpend).mock.calls.at(-1)).toEqual([
      undefined,
      DEPIX.identifier,
      9_950,
      4_975_000_000,
    ])
    expect(sparkConfirmConvert).toHaveBeenCalledWith('leg2b')
  })

  test('when the second leg fails, it says the value stayed in bitcoin', async () => {
    jest.mocked(sparkConfirmConvert).mockResolvedValue('failed')
    const tree = await pair()
    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    await pressBtn(tree, 'Confirm conversion')

    const shown = textStrings(tree)
    expect(shown).toContain('The conversion stopped halfway. The value is in bitcoin in your wallet.')
    expect(shown).not.toContain('Could not convert.')
  })

  // The SDK can raise its 30 second wait after the swap already ran, so a throw is not a failure
  // until the balance says the source never left.
  test('a first leg that throws after its swap ran stops in bitcoin, and does not quote the pair again', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      holding(40_000_000, 9_950)
      throw new Error('SdkError.Generic')
    })
    const tree = await pair()
    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    jest.mocked(sparkPrepareConvertBySpend).mockClear()
    await pressBtn(tree, 'Confirm conversion')
    await settleQuote()

    expect(textStrings(tree)).toContain(STOPPED)
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('leg2')
    expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
  })

  test('a first leg that throws before anything moved is an ordinary failure', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockRejectedValue(new Error('SdkError.Generic'))
    const tree = await pair()
    await reviewAndConfirm(tree)

    const shown = textStrings(tree)
    expect(shown).toContain('Could not convert.')
    expect(shown).not.toContain(STOPPED)
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('leg2')
  })

  test('when the wallet cannot be read after a throw, it asks to check the balance', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      jest.mocked(sparkGetWalletInfo).mockRejectedValue(new Error('offline'))
      throw new Error('SdkError.Generic')
    })
    const tree = await pair()
    await reviewAndConfirm(tree)

    expect(textStrings(tree)).toContain(CHECK)
  })

  test('a second leg that throws after its sats left waits for the DePix, not says bitcoin', async () => {
    holding(40_000_000, 9_950)
    jest.mocked(sparkConfirmConvert).mockImplementation(async () => {
      holding(40_000_000, 0)
      throw new Error('SdkError.Generic')
    })
    const tree = await pair()
    await reviewAndConfirm(tree)

    expect(textStrings(tree)).not.toContain(STOPPED)
    expect(textStrings(tree)).not.toContain('Could not convert.')
  })

  // The context can lag the SDK, which is the one that sweeps.
  test('confirm asks the SDK for the dollar wallet, and refuses without running a leg', async () => {
    const tree = await pair()
    await enterSend(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
    await pressBtn(tree, 'Confirm conversion')

    expect(sparkConfirmConvertLeg).not.toHaveBeenCalled()
    expect(textStrings(tree)).toContain(
      'With the dollar wallet on, a token can only be converted into dollars, because the bitcoin in between would turn back into dollars.',
    )
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
  })

  test('a second leg that would spend more sats than arrived is not run', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockResolvedValue({ status: 'complete', receivedBaseUnits: 9_950 })
    jest.mocked(sparkPrepareConvertBySpend).mockImplementation(async (fromId, toId, spend) =>
      fromId === USDB.identifier
        ? LEG1
        : spend === 9_950
        ? { handle: 'leg2b', spentBaseUnits: 9_990, receivedBaseUnits: 4_925_000_000, feeBaseUnits: 0 }
        : LEG2,
    )
    const tree = await pair()
    await reviewAndConfirm(tree)

    expect(sparkConfirmConvert).not.toHaveBeenCalled()
    expect(textStrings(tree)).toContain(STOPPED)
  })

  test('a second leg priced well below the review is not run', async () => {
    jest.mocked(sparkPrepareConvertBySpend).mockImplementation(async (fromId, toId, spend) =>
      fromId === USDB.identifier
        ? LEG1
        : spend === 9_950
        ? { handle: 'leg2b', spentBaseUnits: 9_950, receivedBaseUnits: 4_700_000_000, feeBaseUnits: 0 }
        : LEG2,
    )
    const tree = await pair()
    await reviewAndConfirm(tree)

    expect(sparkConfirmConvert).not.toHaveBeenCalled()
    expect(textStrings(tree)).toContain(STOPPED)
  })

  // The value is bitcoin now, so the form offers the leg that is left instead of the one that ran.
  test('after stopping halfway, the form is bitcoin to DePix', async () => {
    jest.mocked(sparkConfirmConvert).mockResolvedValue('failed')
    const tree = await pair()
    await reviewAndConfirm(tree)

    expect(cards(tree).map(card => card.props.asset.id)).toEqual(['btc', DEPIX.identifier])
  })

  // No exact output exists across two pools, so a typed receive spends the estimate, and once more
  // scaled to what the first quote gave.
  test('a receive typed on a pair is corrected once toward the amount asked for', async () => {
    const tree = await pair()
    jest.mocked(sparkPrepareConvertBySpend).mockClear()
    await enterReceive(tree, 50)
    await settleQuote()

    const firstLegs = jest
      .mocked(sparkPrepareConvertBySpend)
      .mock.calls.filter(([fromId]) => fromId === USDB.identifier)
      .map(([, , spend]) => spend)
    // 50 DePix is 50 reais, which is 10 USDB; the first quote gave 49, so it asks for 50/49 more.
    expect(firstLegs).toEqual([10_000_000, 10_204_082])
  })

  test('a pair with no rate can still be typed on the send side', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    const tree = await pair()
    expect(cards(tree)[0]!.props.editable).toBe(true)
  })

  test('the minimum of a pair covers the second leg too', async () => {
    jest.mocked(sparkConversionLimits).mockImplementation(async (fromId, toId) =>
      fromId === USDB.identifier && toId === undefined
        ? { minFromBaseUnits: 1_000_000, minToBaseUnits: 1_000 }
        : fromId === undefined && toId === DEPIX.identifier
        ? { minFromBaseUnits: 2_000, minToBaseUnits: 1_000_000_000 }
        : {},
    )
    const tree = await pair()
    jest.mocked(sparkPrepareConvertBySpend).mockClear()
    await pressBtn(tree, 'Min')
    await settleQuote()

    // 2_000 sats is 2 USDB at 100_000 dollars per bitcoin, above the first leg's 1 USDB.
    expect(jest.mocked(sparkPrepareConvertBySpend).mock.calls[0]?.[2]).toBe(2_000_000n)
    jest.mocked(sparkConversionLimits).mockResolvedValue({})
  })

  test('a quote still in flight when the direction flips is dropped', async () => {
    let land: (q: typeof LEG1) => void = () => {}
    const tree = await pair()
    jest.mocked(sparkPrepareConvertBySpend).mockImplementationOnce(
      () => new Promise(resolve => (land = resolve)),
    )
    await enterSend(tree, 10)
    await settleQuote()
    const swapButton = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Swap direction' && typeof n.props.onPress === 'function',
    )[0]!
    await ReactTestRenderer.act(async () => swapButton.props.onPress())
    await ReactTestRenderer.act(async () => land(LEG1))
    await flush()

    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('leg1')
  })
})

// Under reduced motion the arrow between the sides does not turn, and the sides still swap.
describe('the swap under reduced motion', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test.each([
    [true, 0],
    [false, 1],
  ])('reduced %s turns the arrow %i times', async (reduced, turns) => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
    const timing = jest.spyOn(Animated, 'timing')
    const tree = await render()
    await flush()
    const sides = () =>
      tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined).map(n => n.props.asset.id)
    const before = sides()
    const swapButton = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Swap direction' && typeof n.props.onPress === 'function',
    )[0]!
    timing.mockClear()
    await ReactTestRenderer.act(async () => swapButton.props.onPress())

    expect(sides()).toEqual([...before].reverse())
    const spins = timing.mock.calls.filter(([, config]) => (config as { toValue?: unknown }).toValue === 180)
    expect(spins).toHaveLength(turns)
  })
})

describe('formatPairRate', () => {
  test('two places when one unit buys at least one', () => {
    expect(formatPairRate(4.9)).toBe('4.90')
  })

  test('significant digits when one unit buys less than one, so it never reads 0.00', () => {
    expect(formatPairRate(0.2016)).toBe('0.202')
    expect(formatPairRate(0.00012)).toBe('0.00012')
  })
})

describe('bitcoin in its own units', () => {
  test('the range keeps sats grouped with a no-break space', async () => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 47_112, tokens: [] })
    jest.mocked(sparkConversionLimits).mockResolvedValue({ minFromBaseUnits: 800 })
    const tree = await render()
    await flush()
    await flush()

    expect(textStrings(tree)).toContain('Between 800 and 47\u00a0112 sats')
    jest.mocked(sparkConversionLimits).mockResolvedValue({})
  })

  // The range is a sentence of amounts, and a cap of one line cut it mid-figure at the largest sizes
  // ("80…" in Turkish), so it wraps between words, and the chips go under it once they no longer fit.
  describe('the range line at every text size', () => {
    const start = Dimensions.get('window')
    const setScale = (fontScale: number) => {
      const window = { ...start, fontScale }
      ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
    }
    afterEach(async () => {
      setScale(start.fontScale)
      jest.mocked(sparkConversionLimits).mockResolvedValue({})
      await i18n.changeLanguage('en-US')
    })

    async function opened(): Promise<ReactTestRenderer.ReactTestRenderer> {
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 47_112, tokens: [] })
      jest.mocked(sparkConversionLimits).mockResolvedValue({ minFromBaseUnits: 800 })
      const tree = await render()
      await flush()
      await flush()
      return tree
    }
    const RANGE = 'Between 800 and 47\u00a0112 sats'
    const hintOf = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(Txt).find(n => n.props.children === RANGE)!
    // The box the sentence and the chips are laid out in, and the order of its two children.
    function line(tree: ReactTestRenderer.ReactTestRenderer) {
      const text = hintOf(tree).findByType(Text)
      const box = hostParent(text)!
      const style = StyleSheet.flatten(box.props.style)
      const order = box.children.map(child =>
        typeof child !== 'string' && child.findAllByType(Text).some(n => n.props.children === RANGE)
          ? 'hint'
          : typeof child !== 'string' && child.findAllByType(Text).some(n => n.props.children === 'Max')
            ? 'chips'
            : '?',
      )
      return { row: style.flexDirection === 'row', order, hintStyle: StyleSheet.flatten(text.props.style) }
    }

    test('the sentence has no line cap and wraps between whole words', async () => {
      const tree = await opened()
      const hint = hintOf(tree)
      expect(hint.props.lines).toBeUndefined()
      expect(hint.props.wholeWords).toBe(true)
      expect(hint.findByType(Text).props.numberOfLines).toBeUndefined()
    })

    test('the chips sit beside the sentence while both fit, and go under it at the largest sizes', async () => {
      const wide = line(await opened())
      expect(wide).toMatchObject({ row: true, order: ['hint', 'chips'] })
      expect(wide.hintStyle.flex).toBe(1)

      setScale(3.12)
      const tall = line(await opened())
      expect(tall).toMatchObject({ row: false, order: ['hint', 'chips'] })
      // A zero basis in a column would lay the sentence out at no height.
      expect(tall.hintStyle.flex).toBeUndefined()
    })

    test('stacked, Min and Max still spend the range the sentence shows', async () => {
      setScale(3.12)
      const tree = await opened()
      expect(line(tree).row).toBe(false)
      jest.mocked(sparkPrepareConvertBySpend).mockClear()
      await pressBtn(tree, 'Min')
      await settleQuote()
      await pressBtn(tree, 'Max')
      await settleQuote()
      expect(jest.mocked(sparkPrepareConvertBySpend).mock.calls.map(call => call[2])).toEqual([800, 47_112])
    })

    test('a grouped amount in the range has no space a line can break at', async () => {
      await i18n.changeLanguage('fr')
      jest.mocked(sparkGetWalletInfo).mockResolvedValue({
        sync: 'synced',
        recoverableSat: 0,
        balanceSat: 0,
        tokens: [
          { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 12_345_670_000 },
        ],
      })
      jest.mocked(sparkConversionLimits).mockResolvedValue({ minFromBaseUnits: 2_500_000_000 })
      const tree = await render()
      await flush()
      const sendCard = tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)[0]!
      await ReactTestRenderer.act(async () => sendCard.props.onPickAsset())
      await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(USDB.identifier))
      await flush()
      await flush()
      const hint = tree.root
        .findAllByType(Txt)
        .map(n => n.props.children)
        .find((c): c is string => typeof c === 'string' && /\d.* USDB$/.test(c))
      expect(hint).toBeDefined()
      // Both figures are grouped, so the check has a group to look at.
      expect(hint).toMatch(/2\u202f500/)
      expect(hint).toMatch(/12\u202f345/)
      expect(hint).not.toMatch(/\d \d/)
    })
  })

  // The card says Bitcoin, so the list it opens says the same, on the network it lives on.
  test('the picker titles bitcoin Bitcoin and names no rail', async () => {
    // Two held assets, since a side with one choice is a fact and opens no list.
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 5_000,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 1_000_000 },
      ],
    })
    const tree = await render()
    await flush()
    const sendCard = tree.root.findAll(n => 'onPickAsset' in n.props)[0]!
    await ReactTestRenderer.act(async () => sendCard.props.onPickAsset())
    const btc = tree.root
      .findByType(AssetPickerSheet)
      .props.items.find((i: { assetId: string }) => i.assetId === 'btc')
    expect(btc).toMatchObject({ ticker: 'Bitcoin', name: '' })
  })
})

// In dollar mode the wallet turns loose sats into USDB by itself, so a token becomes dollars by its first
// leg alone, and the mode runs the second. At 100_000 USD and 500_000 BRL per bitcoin, 1 DePix is 200 sats.
describe('a token into dollars, in dollar mode', () => {
  const RATES: Record<string, number> = { USD: 100_000, BRL: 500_000 }
  const LEG1 = { handle: 'dleg1', spentBaseUnits: 100_000_000, receivedBaseUnits: 198, feeBaseUnits: 0 }
  const LEG2 = { handle: 'dleg2', spentBaseUnits: 198, receivedBaseUnits: 196_000, feeBaseUnits: 0 }
  const OTHER = { identifier: 'btkn1other', ticker: 'OTH', name: 'Other', decimals: 8 }
  const wallet = (usdb: number, depix: number, sats = 0, other = 0) =>
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: sats,
      tokens: [
        { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: usdb },
        { identifier: DEPIX.identifier, ticker: DEPIX.ticker, name: DEPIX.name, decimals: 8, balanceBaseUnits: depix },
        ...(other > 0 ? [{ ...OTHER, balanceBaseUnits: other }] : []),
      ],
    })

  beforeEach(async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    mockDollarMode = true
    jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
    wallet(10_000_000, 100_000_000)
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
    jest.mocked(sparkPrepareConvertBySpend).mockImplementation(async (fromId, toId) => {
      if (fromId === DEPIX.identifier && toId === undefined) {
        return LEG1
      }
      if (fromId === undefined && toId === USDB.identifier) {
        return LEG2
      }
      throw new Error(`unexpected leg ${fromId} -> ${toId}`)
    })
    jest.mocked(sparkConfirmConvertLeg).mockResolvedValue({ status: 'complete', receivedBaseUnits: 198 })
  })
  afterEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    mockDollarMode = false
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
  })

  const cards = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined && 'onPressAmount' in n.props)

  async function opened(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await flush()
    await flush()
    return tree
  }

  async function confirmOne(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await enterSend(tree, 1)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    await pressBtn(tree, 'Confirm conversion')
  }

  test('opens on the held token turning into USDB', async () => {
    const tree = await opened()
    expect(cards(tree).map(card => card.props.asset.id)).toEqual([DEPIX.identifier, USDB.identifier])
  })

  // Sats waiting to become dollars are held too, and still not a source.
  test('offers only tokens that can become dollars, and does not swap the other way', async () => {
    wallet(10_000_000, 100_000_000, 500, 100_000_000)
    const tree = await opened()
    await ReactTestRenderer.act(async () => cards(tree)[0]!.props.onPickAsset())
    const offered = tree.root.findByType(AssetPickerSheet).props.items.map((i: { assetId: string }) => i.assetId)
    expect(offered).toEqual([DEPIX.identifier, OTHER.identifier])
    expect(cards(tree)[1]!.props.onPickAsset).toBeUndefined()
    const swapButton = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Swap direction' && typeof n.props.onPress === 'function',
    )[0]!
    expect(swapButton.props.disabled).toBe(true)
  })

  // The dollars are converted by the mode after the first leg, so the review can only estimate them.
  test('the review reads the dollars that arrive as an estimate, with one fee', async () => {
    const tree = await opened()
    await enterSend(tree, 1)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    const shown = textStrings(tree)
    expect(shown).toContain('≈ 0.196 USDB')
    expect(shown.filter(text => text === 'Fee')).toHaveLength(1)
  })

  test('confirming runs the first leg alone and leaves the second to the dollar wallet', async () => {
    const tree = await opened()
    await confirmOne(tree)

    expect(sparkConfirmConvertLeg).toHaveBeenCalledWith('dleg1')
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('dleg2')
    expect(sparkConfirmConvert).not.toHaveBeenCalled()
  })

  test('once the dollars land, the success shows the USDB that arrived', async () => {
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_150_000, 0)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })

    const amount = tree.root.findByType(ReceivedOverlay).props.amount
    expect(amount.unit).toBe('USDB')
    expect(amount.value).toBeCloseTo(0.15, 6)
  })

  // The sweep lands 30 to 50 seconds after the leg as measured, so the wait runs a minute.
  test('dollars that land 50 seconds after the leg still show as dollars', async () => {
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_000_000, 0, 198)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(48_000)
    })
    expect(overlayAmount(tree)).toBeUndefined()

    wallet(10_196_000, 0, 0)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(4_000)
    })
    expect(overlayAmount(tree).unit).toBe('USDB')
    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // Says only what arrived, since the sats still waiting are what the Home line then counts.
  test('when the wait runs out first, the success shows the sats that arrived', async () => {
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_000_000, 0, 198)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(62_000)
    })

    const amount = tree.root.findByType(ReceivedOverlay).props.amount
    expect(amount.unit).toBe('sats')
    expect(amount.value).toBe(198)
  })

  const overlayAmount = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(ReceivedOverlay)[0]?.props.amount

  test('a first leg that throws before the token left is an ordinary failure', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockRejectedValue(new Error('SdkError.Generic'))
    const tree = await opened()
    await confirmOne(tree)

    expect(textStrings(tree)).toContain('Could not convert.')
    expect(overlayAmount(tree)).toBeUndefined()
  })

  test('when the wallet cannot be read after a throw, it asks to check the balance', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      jest.mocked(sparkGetWalletInfo).mockRejectedValue(new Error('offline'))
      throw new Error('SdkError.Generic')
    })
    const tree = await opened()
    await confirmOne(tree)

    expect(textStrings(tree)).toContain(
      'Could not confirm whether the conversion went through. Check your balance before trying again.',
    )
  })

  test('a first leg that throws after the token left still waits for the dollars', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_150_000, 0)
      throw new Error('SdkError.Generic')
    })
    const tree = await opened()
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })

    expect(textStrings(tree)).not.toContain('Could not convert.')
    expect(overlayAmount(tree).unit).toBe('USDB')
    expect(overlayAmount(tree).value).toBeCloseTo(0.15, 6)
  })

  // The throw hides how many sats arrived, so the success counts them from the balance.
  test('after a throw, sats that arrive without turning into dollars are counted from the balance', async () => {
    wallet(10_000_000, 100_000_000, 14)
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_000_000, 0, 212)
      throw new Error('SdkError.Generic')
    })
    const tree = await opened()
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(62_000)
    })

    expect(overlayAmount(tree).unit).toBe('sats')
    expect(overlayAmount(tree).value).toBe(198)
  })

  // Neither the dollars nor the sats showed up, so the screen cannot say where the value is.
  test('after a throw, when nothing arrives, it asks to check the balance', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_000_000, 0)
      throw new Error('SdkError.Generic')
    })
    const tree = await opened()
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(62_000)
    })

    const shown = textStrings(tree)
    expect(shown).toContain(
      'Could not confirm whether the conversion went through. Check your balance before trying again.',
    )
    expect(shown).not.toContain('The conversion stopped halfway. The value is in bitcoin in your wallet.')
    expect(overlayAmount(tree)).toBeUndefined()
  })

  test('a first leg that fails leaves the dollars alone and says so', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockResolvedValue({ status: 'failed', receivedBaseUnits: 0 })
    const tree = await opened()
    await confirmOne(tree)

    expect(textStrings(tree)).toContain('Could not convert.')
    expect(overlayAmount(tree)).toBeUndefined()
    expect(sparkConfirmConvert).not.toHaveBeenCalled()
  })

  // Offline through the whole wait, the leg's own count is the only one there is.
  test('when the wallet cannot be read after the leg, the success shows the sats the leg reported', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      jest.mocked(sparkGetWalletInfo).mockRejectedValue(new Error('offline'))
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    const tree = await opened()
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(62_000)
    })

    expect(overlayAmount(tree).unit).toBe('sats')
    expect(overlayAmount(tree).value).toBe(198)
  })

  test('a later conversion does not show the dollars of the one before', async () => {
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(12_000_000, 100_000_000)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })
    await ReactTestRenderer.act(async () => tree.root.findByType(ReceivedOverlay).props.onDone())

    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
    jest.mocked(sparkConfirmConvertLeg).mockResolvedValue({ status: 'complete', receivedBaseUnits: 198 })
    jest.mocked(sparkConfirmConvert).mockImplementation(async () => {
      wallet(12_196_000, 0)
      return 'complete'
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })

    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // The review stays up with its spinner through the wait, and a requote there would bring Convert
  // back over a warning about a conversion whose token already left.
  test('Cancel does nothing while a confirm is running', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_000_000, 0)
      throw new Error('SdkError.Generic')
    })
    const tree = await opened()
    await confirmOne(tree)
    jest.mocked(sparkPrepareConvertBySpend).mockClear()
    await pressBtn(tree, 'Cancel')
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(62_000)
    })

    expect(textStrings(tree)).toContain(
      'Could not confirm whether the conversion went through. Check your balance before trying again.',
    )
    expect(sparkPrepareConvertBySpend).not.toHaveBeenCalled()
  })

  // The range reads at two places, the minimum up and the maximum down, while the chips spend what
  // each one means: Min the figure on the line, which clears the real minimum, and Max the whole balance.
  describe('the range line', () => {
    beforeEach(() => {
      wallet(10_000_000, 791_144_120)
      jest.mocked(sparkConversionLimits).mockImplementation(async (fromId, toId) =>
        fromId === DEPIX.identifier && toId === undefined ? { minFromBaseUnits: 349_911_263 } : {},
      )
    })
    afterEach(() => {
      jest.mocked(sparkConversionLimits).mockResolvedValue({})
    })

    test('reads the minimum rounded up and the balance rounded down, at two places', async () => {
      const tree = await opened()
      expect(textStrings(tree)).toContain('Between 3.50 and 7.91 DePix')
    })

    test('Min spends the minimum the line shows', async () => {
      const tree = await opened()
      jest.mocked(sparkPrepareConvertBySpend).mockClear()
      await pressBtn(tree, 'Min')
      await settleQuote()
      expect(jest.mocked(sparkPrepareConvertBySpend).mock.calls[0]?.[2]).toBe(350_000_000n)
    })

    test('Max spends the whole balance, not the figure on the line', async () => {
      const tree = await opened()
      jest.mocked(sparkPrepareConvertBySpend).mockClear()
      await pressBtn(tree, 'Max')
      await settleQuote()
      expect(jest.mocked(sparkPrepareConvertBySpend).mock.calls[0]?.[2]).toBe(791_144_120n)
    })
  })

  // A sweep that landed after the screen last read the wallet is not this conversion's.
  test('the dollars counted are the rise from a read taken at confirm, not from the screen', async () => {
    const tree = await opened()
    wallet(10_500_000, 100_000_000)
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_696_000, 0)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })

    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // Dollars rising while the leg's sats are still loose come from other sats, so the wait goes on
  // until the sweep has taken these.
  test('a rise in dollars while the leg sats are still loose is not taken as this conversion', async () => {
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_700_000, 0, 198)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(4100)
    })
    expect(overlayAmount(tree)).toBeUndefined()

    wallet(10_896_000, 0, 0)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2000)
    })
    expect(overlayAmount(tree).unit).toBe('USDB')
    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // After a throw the leg's sats are unknown, so they count as gone only once the sats are back where
  // they were at confirm.
  test('after a throw, a rise in dollars while sats are still above where they were is not this conversion', async () => {
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_700_000, 0, 198)
      throw new Error('SdkError.Generic')
    })
    const tree = await opened()
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(4100)
    })
    expect(overlayAmount(tree)).toBeUndefined()

    wallet(10_896_000, 0, 0)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2000)
    })
    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // Sats already loose at confirm can be swept on their own while this leg's are still loose.
  test('a sweep of sats that were loose before the conversion is not taken as this one', async () => {
    wallet(10_000_000, 100_000_000, 50_000)
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(60_000_000, 0, 198)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })
    expect(overlayAmount(tree)).toBeUndefined()

    wallet(60_196_000, 0, 0)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2000)
    })
    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // One sweep converts every loose sat at one price, so this leg's share of the rise is its share of
  // the sats swept, with a few sats already waiting when the leg lands.
  test('sats swept together with this leg count only by this leg share of them', async () => {
    wallet(10_000_000, 100_000_000, 14)
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_940_346, 0, 0)
      return { status: 'complete', receivedBaseUnits: 1_114 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })

    expect(overlayAmount(tree).value).toBeCloseTo(0.928675, 6)
  })

  // The sweep can leave a remainder, and dollars rising with fewer sats than the leg brought is the sweep
  // having taken them.
  test('a sweep that leaves a few of the leg sats behind still counts as this conversion', async () => {
    const tree = await opened()
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(async () => {
      wallet(10_189_000, 0, 8)
      return { status: 'complete', receivedBaseUnits: 198 }
    })
    await confirmOne(tree)
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })

    expect(overlayAmount(tree).unit).toBe('USDB')
    expect(overlayAmount(tree).value).toBeCloseTo(0.189, 6)
  })

  // The context can lag the SDK, which is the one that sweeps, so the SDK decides at confirm.
  test('with the screen still thinking the mode is off, the SDK at confirm sends a pair into dollars down the dollar path', async () => {
    mockDollarMode = false
    const tree = await opened()
    await ReactTestRenderer.act(async () => cards(tree)[0]!.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(DEPIX.identifier))
    await ReactTestRenderer.act(async () => cards(tree)[1]!.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(USDB.identifier))
    await confirmOne(tree)

    expect(sparkConfirmConvertLeg).toHaveBeenCalledWith('dleg1')
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('dleg2')
    expect(sparkConfirmConvert).not.toHaveBeenCalled()
  })

  test('with the mode off, a held token does not change where the screen opens, and the swap works', async () => {
    mockDollarMode = false
    const tree = await opened()
    expect(cards(tree).map(card => card.props.asset.id)).toEqual([SPARK_BTC.id, USDB.identifier])
    const swapButton = tree.root.findAll(
      n => n.props.accessibilityLabel === 'Swap direction' && typeof n.props.onPress === 'function',
    )[0]!
    expect(swapButton.props.disabled).toBeFalsy()
  })

  // With the mode off the load only settles the receive side, so the typed spend keeps its meaning.
  test('an amount typed while the wallet loads stays once it has loaded', async () => {
    mockDollarMode = false
    let release!: () => void
    const loaded = new Promise<void>(resolve => {
      release = resolve
    })
    const info = jest.mocked(sparkGetWalletInfo).getMockImplementation()!
    jest.mocked(sparkGetWalletInfo).mockImplementation(async () => {
      await loaded
      return info()
    })
    const tree = await render()
    await enterSend(tree, 1)
    release()
    await flush()
    await flush()

    expect(cards(tree)[0]!.props.value).toBe('1')
  })

  // In dollar mode the load moves the send side off bitcoin, so sats typed meanwhile would become a token.
  test('in dollar mode, an amount typed while the wallet loads goes when the send side moves', async () => {
    let release!: () => void
    const loaded = new Promise<void>(resolve => {
      release = resolve
    })
    const info = jest.mocked(sparkGetWalletInfo).getMockImplementation()!
    jest.mocked(sparkGetWalletInfo).mockImplementation(async () => {
      await loaded
      return info()
    })
    const tree = await render()
    await enterSend(tree, 1000)
    release()
    await flush()
    await flush()

    expect(cards(tree).map(card => [card.props.asset.id, card.props.value])).toEqual([
      [DEPIX.identifier, ''],
      [USDB.identifier, ''],
    ])
  })

  test('opens on a held token, past a pegged remainder under a cent listed before it', async () => {
    wallet(10_000_000, 440_000, 0, 100_000_000)
    const tree = await opened()
    expect(cards(tree).map(card => card.props.asset.id)).toEqual([OTHER.identifier, USDB.identifier])
  })

  test('opens on a held token, past a token at zero listed before it', async () => {
    wallet(10_000_000, 0, 0, 100_000_000)
    const tree = await opened()
    expect(cards(tree).map(card => card.props.asset.id)).toEqual([OTHER.identifier, USDB.identifier])
  })

  // One held token is a fact on the send side too, drawn without the chevron a picker carries.
  test('a send side with one choice is a fact, without a chevron', async () => {
    const tree = await opened()
    const sendCard = cards(tree)[0]!
    expect(sendCard.props.onPickAsset).toBeUndefined()
    expect(sendCard.findAll(n => n.props.name === 'chevron')).toHaveLength(0)
  })

  test('a side that can pick draws the chevron', async () => {
    wallet(10_000_000, 100_000_000, 0, 100_000_000)
    const tree = await opened()
    expect(cards(tree)[0]!.findAll(n => n.props.name === 'chevron').length).toBeGreaterThan(0)
  })

  // The loading effect runs again when the context catches up, which the confirm's own leg can cause,
  // and the review it would drop is the one being confirmed.
  test('the mode catching up during a confirm leaves the review and the amounts alone', async () => {
    mockDollarMode = false
    let land!: () => void
    jest.mocked(sparkConfirmConvertLeg).mockImplementation(
      () =>
        new Promise(resolve => {
          land = () => {
            wallet(10_196_000, 0)
            resolve({ status: 'complete', receivedBaseUnits: 198 })
          }
        }),
    )
    const tree = await opened()
    await ReactTestRenderer.act(async () => cards(tree)[0]!.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(DEPIX.identifier))
    await ReactTestRenderer.act(async () => cards(tree)[1]!.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(USDB.identifier))
    await confirmOne(tree)

    mockDollarMode = true
    await ReactTestRenderer.act(async () => tree.update(<ConvertSpark />))
    await flush()
    await flush()
    expect(tree.root.findAll(n => n.props.closeLabel === 'Cancel')[0]!.props.visible).toBe(true)
    expect(cards(tree)[0]!.props.value).not.toBe('')

    await ReactTestRenderer.act(async () => land())
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(2100)
    })
    expect(overlayAmount(tree).value).toBeCloseTo(0.196, 6)
  })

  // With nothing to turn into dollars, the form is bitcoin into dollars, which the mode does anyway.
  test('the mode turning on with no token to convert leaves bitcoin into dollars', async () => {
    mockDollarMode = false
    wallet(10_000_000, 0, 500_000)
    const tree = await opened()
    await ReactTestRenderer.act(async () => cards(tree)[0]!.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(USDB.identifier))

    mockDollarMode = true
    await ReactTestRenderer.act(async () => tree.update(<ConvertSpark />))
    await flush()
    await flush()

    expect(cards(tree).map(card => card.props.asset.id)).toEqual([SPARK_BTC.id, USDB.identifier])
  })

  // The sides change under whatever was typed or under review, so both go rather than pair with the new sides.
  test('the mode turning on with the screen open moves to a token into dollars and drops the review', async () => {
    mockDollarMode = false
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
    wallet(10_000_000, 100_000_000, 500_000)
    jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue({
      handle: 'h1',
      spentBaseUnits: 210_000,
      receivedBaseUnits: 10_000_000,
      feeBaseUnits: 0,
    })
    const tree = await opened()
    await enterSend(tree, 210_000)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    mockDollarMode = true
    await ReactTestRenderer.act(async () => tree.update(<ConvertSpark />))
    await flush()
    await flush()

    expect(cards(tree).map(card => card.props.asset.id)).toEqual([DEPIX.identifier, USDB.identifier])
    expect(cards(tree).map(card => card.props.value)).toEqual(['', ''])
    expect(tree.root.findAll(n => n.props.closeLabel === 'Cancel')[0]!.props.visible).toBe(false)
    expect(sparkDiscardConvertQuote).toHaveBeenCalledWith('h1')
  })

  test('with the mode off by the SDK at confirm, the pair runs both legs itself', async () => {
    jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
    jest.mocked(sparkConfirmConvert).mockResolvedValue('complete')
    const tree = await opened()
    await confirmOne(tree)

    expect(sparkConfirmConvertLeg).toHaveBeenCalledWith('dleg1')
    expect(sparkConfirmConvert).toHaveBeenCalled()
  })
})

// A label and the figure it names share one row by one rule, so a long label at the largest text
// size cannot squeeze the amount beside it to a few points.
describe('the rows at large text', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  async function reviewing(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await flush()
    await enterReceive(tree, 10)
    await settleQuote()
    await pressBtn(tree, 'Convert')
    return tree
  }

  test('every figure on the screen and in the confirm sheet sits in a FigureRow', async () => {
    const tree = await reviewing()
    const inRows = new Set(tree.root.findAllByType(FigureRow).flatMap(row => figuresIn(row)))
    const figures = figuresIn(tree.root)
    // The two fields' amounts and fiat lines, and the four confirm rows.
    expect(figures.length).toBeGreaterThanOrEqual(8)
    expect(figures.filter(figure => !inRows.has(figure)).map(textOf)).toEqual([])
    expect(figuresHeldOut(tree.root)).toEqual([])
  })

  // Stacked, the four rows outgrow the sheet's cap, and a sheet does not scroll its children on its
  // own, so without a scroll of its own Confirm sits below the sheet and cannot be reached.
  test('the confirm sheet scrolls, so Confirm stays in reach when the rows stack', async () => {
    setScale(3.571)
    const tree = await reviewing()
    const sheet = tree.root.findAllByType(Sheet).find(node => node.props.visible)!
    const scroll = sheet
      .findAllByType(ScrollView)
      .find(node => node.findAllByType(FigureRow).some(row => row.props.label === 'You receive'))
    expect(scroll).toBeDefined()
    expect(scroll!.findAll(node => node.props.label === 'Confirm conversion').length).toBeGreaterThan(0)
  })

  test('at the largest text size each confirm figure goes under its label', async () => {
    setScale(3.571)
    const tree = await reviewing()
    const labels = ['You send', 'You receive', 'Rate', 'Fee']
    const rows = tree.root
      .findAllByType(FigureRow)
      .filter(row => labels.includes(row.props.label as string))
    expect(rows.map(row => row.props.label)).toEqual(labels)
    for (const row of rows) {
      const [figure] = figuresIn(row)
      const box = hostParent(hostParent(figure)!)!
      expect(StyleSheet.flatten(box.props.style).flexDirection).toBe('column')
    }
    expect(figuresHeldOut(tree.root)).toEqual([])
  })
})

// The asset selector takes the label's share of a field's row and the amount the figure's, so each
// keeps to its own target: the selector to its own width, the amount never under a touch target.
test('a field keeps the selector to its own width and the amount at least a touch target wide', async () => {
  const tree = await render()
  await flush()
  const amount = tree.root.find(
    n => n.props.accessibilityLabel === 'Receive' && typeof n.props.onPress === 'function' && n.props.style,
  )
  expect(StyleSheet.flatten(amount.props.style)).toMatchObject({ minWidth: touch.min })
  // The two fields' rows, whose label is the selector.
  const fields = tree.root
    .findAllByType(FigureRow)
    .filter(row => row.findAllByType(AssetIcon).length > 0)
  expect(fields).toHaveLength(2)
  for (const field of fields) {
    const { style } = (field.props.label as React.ReactElement<{ style: unknown }>).props
    const own = typeof style === 'function' ? style({ pressed: false }) : style
    expect(StyleSheet.flatten(own)).toMatchObject({ alignSelf: 'flex-start' })
    const name = field.findAllByType(Txt).find(n => n.props.role === 'subheading')!
    expect(name.props.wholeWords).toBe(true)
  }
})

// A double carries about 15 significant digits, so a token at 18 places typed as 1.000000000000000001
// would be converted as 1 if the figure passed through one. Six places are the control.
describe('a typed token amount is converted as typed', () => {
  // Held past the safe integers, so no balance locks the keypad and the figure alone is weighed.
  const EIGHTEEN = { identifier: 'btkn1eighteen', ticker: 'EIGHT', name: 'Eighteen', decimals: 18, balanceBaseUnits: 5e18 }
  const HELD_USDB = { identifier: USDB.identifier, ticker: USDB.ticker, name: USDB.name, decimals: 6, balanceBaseUnits: 5e18 }
  const QUOTE = { handle: 'q', spentBaseUnits: 1, receivedBaseUnits: 1, feeBaseUnits: 0 }
  const CASES: [number, string, string, bigint][] = [
    [18, EIGHTEEN.identifier, '1.000000000000000001', 1_000_000_000_000_000_001n],
    [6, USDB.identifier, '1.000001', 1_000_001n],
  ]

  beforeEach(() => {
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced',
      recoverableSat: 0,
      balanceSat: 100_000,
      tokens: [EIGHTEEN, HELD_USDB],
    })
    jest.mocked(sparkPrepareConvert).mockResolvedValue(QUOTE)
    jest.mocked(sparkPrepareConvertBySpend).mockResolvedValue({ ...QUOTE, expectedBaseUnits: 1 })
  })

  async function choose(tree: ReactTestRenderer.ReactTestRenderer, side: 0 | 1, id: string): Promise<void> {
    const card = tree.root.findAll(n => 'onPickAsset' in n.props && n.props.asset !== undefined)[side]!
    await ReactTestRenderer.act(async () => card.props.onPickAsset())
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect(id))
  }

  test.each(CASES)('at %i places a token bought with sats is asked for exactly as typed', async (_places, id, typed, base) => {
    const tree = await render()
    await flush()
    await choose(tree, 1, id)
    await enterReceive(tree, typed)
    await settleQuote()

    expect(sparkPrepareConvert).toHaveBeenLastCalledWith(undefined, id, base)
  })

  test.each(CASES)('at %i places a token spent into sats goes in exactly as typed', async (_places, id, typed, base) => {
    const tree = await render()
    await flush()
    await choose(tree, 0, id)
    await choose(tree, 1, SPARK_BTC.id)
    await enterSend(tree, typed)
    await settleQuote()

    expect(jest.mocked(sparkPrepareConvertBySpend).mock.lastCall?.slice(0, 3)).toEqual([id, undefined, base])
  })

  // The quote's figures went through a double, so the cards and the review draw the SDK's exact
  // ones.
  const EXACT = 1_000_000_000_000_000_001n
  const drawn = '1.000000000000000001'

  test('a token bought with sats is drawn as the SDK quoted it', async () => {
    jest
      .mocked(sparkPrepareConvert)
      .mockResolvedValue({ ...QUOTE, receivedBaseUnits: Number(EXACT), receivedExact: EXACT })
    const tree = await render()
    await flush()
    await choose(tree, 1, EIGHTEEN.identifier)
    await enterReceive(tree, drawn)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    expect(textStrings(tree)).toContain(`${drawn} EIGHT`)
  })

  test('a token spent into sats is drawn as the SDK quoted it', async () => {
    jest
      .mocked(sparkPrepareConvertBySpend)
      .mockResolvedValue({
        ...QUOTE,
        spentBaseUnits: Number(EXACT),
        spentExact: EXACT,
        expectedBaseUnits: 1,
      })
    const tree = await render()
    await flush()
    await choose(tree, 0, EIGHTEEN.identifier)
    await choose(tree, 1, SPARK_BTC.id)
    await enterSend(tree, drawn)
    await settleQuote()
    await pressBtn(tree, 'Convert')

    expect(textStrings(tree)).toContain(`${drawn} EIGHT`)
  })

  // The first leg's exact amount is sats, so the pair takes the second leg's for what arrives.
  test('a pair draws what arrives from its second leg', async () => {
    jest.mocked(sparkPrepareConvertBySpend).mockImplementation(async from =>
      from === undefined
        ? {
            ...QUOTE,
            spentBaseUnits: 797,
            spentExact: 797n,
            receivedBaseUnits: Number(EXACT),
            receivedExact: EXACT,
            expectedBaseUnits: Number(EXACT),
          }
        : {
            ...QUOTE,
            spentBaseUnits: 1_000_001,
            spentExact: 1_000_001n,
            receivedBaseUnits: 797,
            receivedExact: 797n,
            expectedBaseUnits: 797,
          },
    )
    const tree = await render()
    await flush()
    await choose(tree, 0, USDB.identifier)
    await choose(tree, 1, EIGHTEEN.identifier)
    await enterSend(tree, '1.000001')
    await settleQuote()
    await pressBtn(tree, 'Convert')

    expect(textStrings(tree)).toContain(`${drawn} EIGHT`)
  })

  test.each(CASES)('at %i places a pair spends exactly the figure typed on its first leg', async (_places, id, typed, base) => {
    const tree = await render()
    await flush()
    await choose(tree, 0, id)
    await choose(tree, 1, id === USDB.identifier ? EIGHTEEN.identifier : USDB.identifier)
    await enterSend(tree, typed)
    await settleQuote()

    expect(jest.mocked(sparkPrepareConvertBySpend).mock.calls[0]?.slice(0, 3)).toEqual([id, undefined, base])
  })
})

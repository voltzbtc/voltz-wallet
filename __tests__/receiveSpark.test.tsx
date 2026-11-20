import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Share, StyleSheet, Text } from 'react-native'
import { rhythm, space } from '../src/theme'
import Clipboard from '@react-native-clipboard/clipboard'
import QRCode from 'react-native-qrcode-svg'
import i18n from '../src/i18n'
import { ReceiveSpark } from '../src/screens/ReceiveSpark'
import {
  sparkConversionLimits,
  sparkReceive,
  sparkGetFiatRates,
  sparkEnsureLnAddress,
  sparkGetWalletInfo,
  sparkListFiatCurrencies,
} from '../src/wallet/spark'
import { AmountSheet } from '../src/components/AmountSheet'
import { AssetPickerSheet } from '../src/components/AssetPickerSheet'
import { DEPIX, USDB } from '../src/wallet/tokens'
import { useDollarMode } from '../src/wallet/dollarMode'
import { addToken } from '../src/wallet/tokenPrefs'
import { saveDisplayCurrency } from '../src/wallet/settings'
import RNFS from 'react-native-fs'
import { getCurrencies } from 'react-native-localize'
import { Skeleton } from '../src/components/Skeleton'
import { SegmentedControl } from '../src/components/SegmentedControl'
import { Touch } from '../src/components/Touch'
import { StableReceivePanel } from '../src/components/StableReceivePanel'
import { formatSats } from '../src/wallet/amount'
import { BITCOIN_ASSET_ID } from '../src/wallet/assets'
import { markedInOpenPicker } from './support/pickerMark'

// The stock mock's region answer, made settable so a test can place the device outside the US.
const STOCK_DEVICE_CURRENCIES = ['USD', 'EUR']
jest.mock('react-native-localize', () => ({
  ...jest.requireActual('react-native-localize/mock'),
  // src/i18n reads it once when it loads, before any beforeEach runs, as the app does at boot.
  getCurrencies: jest.fn(() => ['USD', 'EUR']),
}))

jest.mock('../src/wallet/spark', () => ({
  // In flight, so the cross-chain panel draws and stays out of the cases that reach it.
  sparkListReceiveRoutes: jest.fn(() => new Promise(() => undefined)),
  sparkReceive: jest.fn(),
  sparkConversionLimits: jest.fn(),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkEnsureLnAddress: jest.fn(async () => null),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 0, tokens: [] })),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/dollarMode', () => ({
  ...jest.requireActual('../src/wallet/dollarMode'),
  useDollarMode: jest.fn(() => false),
}))
let mockRouteParams: { assetId?: string } = {}
const mockSetOptions = jest.fn()
const mockNavigate = jest.fn()
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ setOptions: mockSetOptions, navigate: mockNavigate }),
  useRoute: () => ({ params: mockRouteParams }),
}))

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

// The picker sheet's FlatList schedules a timer that jest flags as a late log once the test ends.
let mounted: ReactTestRenderer.ReactTestRenderer | null = null

afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
})

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ReceiveSpark />)
  })
  await flush()
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

// The SegmentedControl renders each rail as a Pressable with accessibilityRole "button" and a label.
// The two actions under the code, found by their labels as a person finds them.
function action(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root.find(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === label,
  )
}

async function pressAction(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  await ReactTestRenderer.act(async () => action(tree, label).props.onPress())
}

async function pressRail(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const seg = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!seg) {
    throw new Error(`rail not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    seg.props.onPress()
  })
  await flush()
}

// The rails other than Lightning wait under More options, a sheet with one row each.
async function openRail(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const open = moreOptions(tree)
  if (!open) {
    throw new Error('no More options line')
  }
  await ReactTestRenderer.act(async () => {
    open.props.onPress()
  })
  const row = optionRows(tree).find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!row) {
    throw new Error(`rail not offered: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    row.props.onPress()
  })
  await flush()
}

const moreOptions = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('receive.moreOptions')))

function optionRows(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestInstance[] {
  const labels = [
    i18n.t('receive.optionLightning'),
    i18n.t('receive.optionBitcoin'),
    i18n.t('receive.optionSpark'),
  ]
  return tree.root
    .findAllByType(Touch)
    .filter(n => n.findAllByType(Text).some(txt => labels.includes(txt.props.children)))
}

const optionLabels = (tree: ReactTestRenderer.ReactTestRenderer) =>
  optionRows(tree).map(row => row.findAllByType(Text)[0].props.children as string)

// Values are in the entered unit, sats for Bitcoin and display units for a token. A token's sheet
// hands on the base units typed, so its figure goes in through the keypad, as typed.
async function enterAmount(
  tree: ReactTestRenderer.ReactTestRenderer,
  value: number | string,
): Promise<void> {
  const sheet = tree.root.findByType(AmountSheet)
  if (sheet.props.tokenBounds) {
    // The amount link, marked by its plus or edit icon, opens the keypad.
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .filter(n => n.findAll(c => c.props.name === 'plus' || c.props.name === 'edit').length > 0)
      .pop()
    await ReactTestRenderer.act(async () => {
      link?.props.onPress()
    })
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
    await flush()
    return
  }
  await ReactTestRenderer.act(async () => {
    sheet.props.onConfirm(value, 'sats')
  })
  await flush()
}

beforeEach(() => {
  jest.clearAllMocks()
  // Reset rather than cleared, since a queued once-answer a test left unread would reach the next test.
  jest.mocked(sparkReceive).mockReset()
  jest.mocked(getCurrencies).mockReturnValue(STOCK_DEVICE_CURRENCIES)
  mockRouteParams = {}
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1default', feeSat: 0 })
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 0, tokens: [] })
})

const ALICE = { username: 'alice', address: 'alice@breez.tips', lnurl: 'lnurl1abc' }

// Lightning is the primary rail: the screen is one identifier to share, with the LNURL in the code.
test('opens on the Lightning address with no tap, and mints nothing', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)

  const tree = await render()

  expect(texts(tree).join('')).toContain('alice@breez.tips')
  expect(tree.root.findAllByType(QRCode)[0].props.value).toBe('lnurl1abc')
  expect(sparkReceive).not.toHaveBeenCalled()
})

test('with no address, Lightning asks for an amountless invoice on mount', async () => {
  const tree = await render()

  expect(sparkReceive).toHaveBeenCalledWith('lightning', undefined, undefined, undefined)
  expect(texts(tree).join('')).toContain('lnbc1default')
})

test('the Spark address comes from More options', async () => {
  const tree = await render()
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'spark1testaddr', feeSat: 0 })

  await openRail(tree, i18n.t('receive.optionSpark'))

  expect(sparkReceive).toHaveBeenCalledWith('spark', undefined, undefined, undefined)
  // The Spark address renders chunked in groups of 4, so strip whitespace before matching.
  expect(texts(tree).join('').replace(/\s/g, '')).toContain('spark1testaddr')
})

// What is received is the one choice left on the screen; how it arrives is not a question.
describe('changing the name from here', () => {
  const change = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(text => text.props.children === i18n.t('receive.lnChange')))

  test('the link goes straight to choosing a name', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
    const tree = await render()

    await ReactTestRenderer.act(async () => change(tree)?.props.onPress())
    expect(mockNavigate).toHaveBeenCalledWith('LnAddress', { choose: true })
  })

  test('there is no link on a one-time invoice', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
    jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1abc', feeSat: 0 })
    const tree = await render()

    expect(change(tree)).toBeUndefined()
  })

  test('there is no link on the Bitcoin address', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
    jest.mocked(sparkReceive).mockResolvedValue({ destination: 'bc1qabc', feeSat: 0 })
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionBitcoin'))

    expect(change(tree)).toBeUndefined()
  })
})

describe('the line under the Bitcoin address', () => {
  const NOTE = 'A network fee is taken from the amount when it arrives.'
  const mockDollar = (on: boolean) => jest.mocked(useDollarMode).mockReturnValue(on)

  async function bitcoinRail(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionBitcoin'))
    return tree
  }

  beforeEach(() => {
    mockDollar(false)
    jest.mocked(sparkConversionLimits).mockReset()
    jest.mocked(sparkConversionLimits).mockResolvedValue({ minFromBaseUnits: 25_000 })
  })

  afterEach(() => {
    mockDollar(false)
  })

  test('shows on the Bitcoin address, as text with no figure', async () => {
    const tree = await bitcoinRail()
    expect(texts(tree).join(' ')).toContain(NOTE)
  })

  test('stays off the Lightning address', async () => {
    const tree = await render()
    expect(texts(tree).join(' ')).not.toContain(NOTE)
  })

  test('names a figure only when the SDK quotes one above zero', async () => {
    jest.mocked(sparkReceive).mockImplementation(async method => ({
      destination: method === 'onchain' ? 'bc1qfee' : 'sp1dest',
      feeSat: method === 'onchain' ? 300 : 0,
    }))
    const tree = await bitcoinRail()
    expect(texts(tree).join(' ')).toContain(`Network fee when it arrives: ${formatSats(300)} sats.`)
    expect(texts(tree).join(' ')).not.toContain(NOTE)
  })

  test('in dollar mode names the minimum the SDK answered', async () => {
    mockDollar(true)
    const tree = await bitcoinRail()
    expect(sparkConversionLimits).toHaveBeenCalledWith(undefined, USDB.identifier)
    expect(texts(tree).join(' ')).toContain(`Below ${formatSats(25_000)} sats it stays in bitcoin.`)
  })

  test.each([
    ['a limit read that fails', () => Promise.reject(new Error('offline'))],
    ['no limit in the answer', () => Promise.resolve({})],
    ['a read with no answer', () => new Promise(() => undefined)],
  ])('in dollar mode %s names no minimum', async (_name, answer) => {
    mockDollar(true)
    jest.mocked(sparkConversionLimits).mockImplementation(answer as never)
    const tree = await bitcoinRail()
    expect(texts(tree).join(' ')).toContain(NOTE)
    expect(texts(tree).join(' ')).not.toContain('Below')
  })

  test('outside dollar mode the minimum is not even asked for', async () => {
    await bitcoinRail()
    expect(sparkConversionLimits).not.toHaveBeenCalled()
  })
})

describe('no choice of rail on the first level', () => {
  it('the one segmented control is what arrives, Bitcoin or Stablecoins', async () => {
    const tree = await render()
    const controls = tree.root.findAllByType(SegmentedControl)
    expect(controls).toHaveLength(1)
    expect(controls[0].props.options.map((o: { value: string }) => o.value)).toEqual(['bitcoin', 'stable'])
  })

  it('More options offers the two other addresses, and nothing on Lightning asks to go back', async () => {
    const tree = await render()
    await ReactTestRenderer.act(async () => moreOptions(tree)!.props.onPress())

    expect(optionLabels(tree)).toEqual([i18n.t('receive.optionBitcoin'), i18n.t('receive.optionSpark')])
  })

  it('from another rail the sheet names the way back and marks where the screen is', async () => {
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionBitcoin'))
    await ReactTestRenderer.act(async () => moreOptions(tree)!.props.onPress())

    expect(optionLabels(tree)).toEqual([
      i18n.t('receive.optionLightning'),
      i18n.t('receive.optionBitcoin'),
      i18n.t('receive.optionSpark'),
    ])
    expect(optionRows(tree).map(row => row.props.state?.selected === true)).toEqual([false, true, false])
  })

  it('picking a rail closes the sheet', async () => {
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    expect(optionRows(tree)).toHaveLength(0)
  })

  it('the way back reaches the Lightning address', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    expect(texts(tree).join('')).not.toContain('alice@breez.tips')

    await openRail(tree, i18n.t('receive.optionLightning'))

    expect(texts(tree).join('')).toContain('alice@breez.tips')
  })

  it('the stable side has no More options, since a token has nowhere else to go', async () => {
    const tree = await render()
    expect(moreOptions(tree)).toBeDefined()
    await pressRail(tree, 'Stablecoins')
    expect(moreOptions(tree)).toBeUndefined()
  })
})

test('the Bitcoin tab with no amount carries the on-chain address + Spark leg (no one-time Lightning)', async () => {
  const tree = await render()
  jest.mocked(sparkReceive).mockClear()
  jest
    .mocked(sparkReceive)
    .mockImplementation(async method =>
      method === 'onchain'
        ? { destination: 'bc1qaddr', feeSat: 0 }
        : { destination: 'sp1sparkaddr', feeSat: 0 },
    )

  await openRail(tree, i18n.t('receive.optionBitcoin'))

  // No bolt11 here, since it is one-time and expiring and the SDK cannot mint a reusable BOLT12 offer.
  expect(sparkReceive).toHaveBeenCalledWith('onchain')
  expect(sparkReceive).toHaveBeenCalledWith('spark')
  expect(sparkReceive).not.toHaveBeenCalledWith('lightning', undefined)
  // The address is shown chunked, so the real encoded URI has to be read off the QR.
  const encoded = tree.root.findAllByType(QRCode)[0].props.value as string
  expect(encoded).toBe('bitcoin:bc1qaddr?spark=sp1sparkaddr')
})

// A paste field takes an address, and a Spark address riding in a copied URI is a rail nobody asked for.
describe('what leaves the on-chain rail with no amount', () => {
  const onchainAnswers = async (method: string) =>
    method === 'onchain'
      ? { destination: 'bc1qaddr', feeSat: 0 }
      : { destination: 'sp1sparkaddr', feeSat: 0 }

  it('copies the address alone, while the QR keeps the BIP21', async () => {
    const tree = await render()
    jest.mocked(sparkReceive).mockImplementation(onchainAnswers as never)
    await openRail(tree, i18n.t('receive.optionBitcoin'))

    await pressAction(tree, i18n.t('receive.copy'))

    expect(Clipboard.setString).toHaveBeenLastCalledWith('bc1qaddr')
    expect(tree.root.findAllByType(QRCode)[0].props.value).toBe('bitcoin:bc1qaddr?spark=sp1sparkaddr')
    expect(texts(tree).join('')).not.toContain('sp1sparkaddr')
  })

  it('shares the address alone', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' })
    const tree = await render()
    jest.mocked(sparkReceive).mockImplementation(onchainAnswers as never)
    await openRail(tree, i18n.t('receive.optionBitcoin'))

    await pressAction(tree, i18n.t('receive.share'))

    expect(share).toHaveBeenCalledWith({ message: 'bc1qaddr' })
    share.mockRestore()
  })

  it('with an amount the URI is the request, so it is what gets copied', async () => {
    const tree = await render()
    jest.mocked(sparkReceive).mockImplementation(async method =>
      method === 'onchain'
        ? { destination: 'bc1qaddr', feeSat: 0 }
        : { destination: method === 'lightning' ? 'lnbc1inv' : 'sp1sparkaddr', feeSat: 0 },
    )
    await openRail(tree, i18n.t('receive.optionBitcoin'))
    await enterAmount(tree, 5000)

    const qr = tree.root.findAllByType(QRCode)[0].props.value as string
    await pressAction(tree, i18n.t('receive.copy'))

    expect(Clipboard.setString).toHaveBeenLastCalledWith(qr)
    expect(qr).toContain('amount=')
  })
})

test('the Bitcoin tab with an amount builds a unified BIP21 folding all three rails', async () => {
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionBitcoin'))
  jest
    .mocked(sparkReceive)
    .mockImplementation(async method =>
      method === 'onchain'
        ? { destination: 'bc1qaddr', feeSat: 0 }
        : method === 'lightning'
        ? { destination: 'lnbc1inv', feeSat: 0 }
        : { destination: 'sp1sparkaddr', feeSat: 0 },
    )

  await enterAmount(tree, 5000)

  expect(sparkReceive).toHaveBeenCalledWith('onchain')
  expect(sparkReceive).toHaveBeenCalledWith('lightning', 5000)
  expect(sparkReceive).toHaveBeenCalledWith('spark')
  const shown = texts(tree).join('')
  expect(shown).toContain('bitcoin:bc1qaddr')
  expect(shown).toContain('lightning=lnbc1inv')
  expect(shown).toContain('spark=sp1sparkaddr')
})

test('does not show a destination when generation fails', async () => {
  jest.mocked(sparkReceive).mockRejectedValue(new Error('nope'))

  const tree = await render()

  const shown = texts(tree).join('')
  expect(shown).not.toContain('lnbc')
  expect(shown).not.toContain('bc1')
})

// A failed code has a way forward on the card itself, through the same path the rail on screen uses.
describe('Try again on a failed code', () => {
  const retry = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('common.retry')))

  test('the failed card has no skeleton and offers Try again', async () => {
    jest.mocked(sparkReceive).mockRejectedValue(new Error('nope'))
    const tree = await render()

    expect(texts(tree)).toContain(i18n.t('receive.failed'))
    expect(retry(tree)).toBeDefined()
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  // Offline with no address remembered there is nothing to show, so the card keeps a way forward and
  // the screen keeps the rails that may still work.
  describe('with no address and no invoice', () => {
    beforeEach(() => {
      jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('offline'))
      jest.mocked(sparkReceive).mockRejectedValue(new Error('offline'))
    })

    it('keeps More options on screen, and the Spark rail still answers', async () => {
      const tree = await render()
      expect(texts(tree)).toContain(i18n.t('receive.failed'))

      jest.mocked(sparkReceive).mockResolvedValue({ destination: 'spark1offline', feeSat: 0 })
      await openRail(tree, i18n.t('receive.optionSpark'))

      expect(texts(tree).join('').replace(/\s/g, '')).toContain('spark1offline')
    })

    it('Try again reads the address again, and an address needs no invoice', async () => {
      const tree = await render()
      expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(1)
      const invoices = jest.mocked(sparkReceive).mock.calls.length
      jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)

      await ReactTestRenderer.act(async () => {
        retry(tree)!.props.onPress()
      })
      await flush()

      expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(2)
      expect(jest.mocked(sparkReceive).mock.calls.length).toBe(invoices)
      expect(texts(tree).join('')).toContain('alice@breez.tips')
      expect(texts(tree)).not.toContain(i18n.t('receive.failed'))
    })

    it('Try again falls to the invoice when the address still has no answer', async () => {
      const tree = await render()
      jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1back', feeSat: 0 })

      await ReactTestRenderer.act(async () => {
        retry(tree)!.props.onPress()
      })
      await flush()

      expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(2)
      expect(texts(tree).join('')).toContain('lnbc1back')
      expect(texts(tree)).toContain(i18n.t('receive.hintInvoice'))
    })

    it('Try again shows the skeleton while the address is read', async () => {
      const tree = await render()
      jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise(() => undefined))

      await ReactTestRenderer.act(async () => {
        retry(tree)!.props.onPress()
      })
      await flush()

      expect(texts(tree)).not.toContain(i18n.t('receive.failed'))
      expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
      expect(moreOptions(tree)).toBeDefined()
    })

    it('with an amount Try again asks for the invoice alone', async () => {
      const tree = await render()
      await enterAmount(tree, 5000)
      jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1billed', feeSat: 0 })

      await ReactTestRenderer.act(async () => {
        retry(tree)!.props.onPress()
      })
      await flush()

      expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(1)
      expect(texts(tree).join('')).toContain('lnbc1billed')
    })

    it('on the Spark rail Try again asks for the Spark address alone', async () => {
      const tree = await render()
      await openRail(tree, i18n.t('receive.optionSpark'))
      jest.mocked(sparkReceive).mockResolvedValue({ destination: 'spark1back', feeSat: 0 })

      await ReactTestRenderer.act(async () => {
        retry(tree)!.props.onPress()
      })
      await flush()

      expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(1)
      expect(texts(tree).join('').replace(/\s/g, '')).toContain('spark1back')
    })
  })

  test('asks the same rail again and shows the code it returns', async () => {
    jest.mocked(sparkReceive).mockRejectedValue(new Error('nope'))
    const tree = await render()
    const before = jest.mocked(sparkReceive).mock.calls.length
    jest.mocked(sparkReceive).mockResolvedValueOnce({ destination: 'lnbc1retried', feeSat: 0 })

    await ReactTestRenderer.act(async () => {
      retry(tree)!.props.onPress()
    })
    await flush()

    expect(sparkReceive).toHaveBeenCalledTimes(before + 1)
    expect(jest.mocked(sparkReceive).mock.lastCall).toEqual(['lightning', undefined, undefined, undefined])
    expect(texts(tree).join('').replace(/\s/g, '')).toContain('lnbc1retried')
    expect(texts(tree)).not.toContain(i18n.t('receive.failed'))
  })

  test('a late answer to a request the retry superseded never shows', async () => {
    type Quote = { destination: string; feeSat: number }
    let late: ((q: Quote) => void) | undefined
    let fresh: ((q: Quote) => void) | undefined
    let billed = 0
    // The amountless invoice hangs, the first invoice for the amount fails, and the retry for that
    // amount hangs until the test answers it.
    jest.mocked(sparkReceive).mockImplementation((method, amount) => {
      if (method === 'lightning' && amount === undefined) {
        return new Promise<Quote>(resolve => (late = resolve)) as ReturnType<typeof sparkReceive>
      }
      if (method === 'lightning') {
        billed += 1
        return billed === 1
          ? Promise.reject(new Error('nope'))
          : (new Promise<Quote>(resolve => (fresh = resolve)) as ReturnType<typeof sparkReceive>)
      }
      return Promise.resolve({ destination: 'spark1addr', feeSat: 0 })
    })
    const tree = await render()
    expect(late).toBeDefined()
    await enterAmount(tree, 21000)
    expect(texts(tree)).toContain(i18n.t('receive.failed'))

    await ReactTestRenderer.act(async () => {
      retry(tree)!.props.onPress()
    })
    await flush()
    expect(billed).toBe(2)
    expect(jest.mocked(sparkReceive).mock.lastCall).toEqual(['lightning', 21000, undefined, undefined])

    await ReactTestRenderer.act(async () => {
      late?.({ destination: 'lnbc1late', feeSat: 0 })
    })
    await flush()
    expect(texts(tree).join('').replace(/\s/g, '')).not.toContain('lnbc1late')

    await ReactTestRenderer.act(async () => {
      fresh?.({ destination: 'lnbc1fresh', feeSat: 0 })
    })
    await flush()
    const shown = texts(tree).join('').replace(/\s/g, '')
    expect(shown).toContain('lnbc1fresh')
    expect(shown).not.toContain('lnbc1late')
  })

  test('a retry superseded by a new amount never shows its late answer', async () => {
    type Quote = { destination: string; feeSat: number }
    let stale: ((q: Quote) => void) | undefined
    let retried = false
    jest.mocked(sparkReceive).mockImplementation((method, amount) => {
      if (amount === undefined) {
        if (!retried) {
          return Promise.reject(new Error('nope'))
        }
        return new Promise<Quote>(resolve => (stale = resolve)) as ReturnType<typeof sparkReceive>
      }
      return Promise.resolve({ destination: `lnbc1for${amount}`, feeSat: 0 })
    })
    const tree = await render()
    expect(texts(tree)).toContain(i18n.t('receive.failed'))

    retried = true
    await ReactTestRenderer.act(async () => {
      retry(tree)!.props.onPress()
    })
    await flush()
    expect(stale).toBeDefined()
    // An amount typed while the retry is in flight asks for its own code.
    await enterAmount(tree, 5000)
    expect(texts(tree).join('').replace(/\s/g, '')).toContain('lnbc1for5000')

    await ReactTestRenderer.act(async () => {
      stale?.({ destination: 'lnbc1stale', feeSat: 0 })
    })
    await flush()
    const shown = texts(tree).join('').replace(/\s/g, '')
    expect(shown).toContain('lnbc1for5000')
    expect(shown).not.toContain('lnbc1stale')
  })
})

test('a prior failure does not shadow the fixed @ after switching back to Lightning', async () => {
  // The @ needs no generate, so the rail must clear a failure left by an earlier one.
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
  jest.mocked(sparkReceive).mockRejectedValue(new Error('nope'))
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  expect(texts(tree)).toContain(i18n.t('receive.failed'))

  await openRail(tree, i18n.t('receive.optionLightning'))

  expect(texts(tree).join('')).toContain('alice@breez.tips')
  expect(texts(tree)).not.toContain(i18n.t('receive.failed'))
})

// The fixed-address line is a promise, so it needs an address behind it.
describe('the Lightning hint', () => {
  it('leaves the control by the rhythm and centres with what is under it', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
    const tree = await render()
    const line = tree.root
      .findAllByType(Text)
      .find(n => n.props.children === i18n.t('receive.hintSparkLightning'))!
    const style = StyleSheet.flatten(line.props.style)
    expect(style.textAlign).toBe('center')
    expect(style.marginTop + space.sm).toBe(rhythm.hintToContent)
  })

  it('says fixed address only with an address', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
    const tree = await render()
    expect(texts(tree)).toContain(i18n.t('receive.hintSparkLightning'))
    expect(texts(tree)).not.toContain(i18n.t('receive.hintInvoice'))
  })

  it.each([
    ['answers nothing', () => jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)],
    ['fails', () => jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('offline'))],
  ])('calls it a one-off invoice when the address read %s', async (_what, arrange) => {
    arrange()
    const tree = await render()
    expect(texts(tree).join('')).toContain('lnbc1default')
    expect(texts(tree)).toContain(i18n.t('receive.hintInvoice'))
    expect(texts(tree)).not.toContain(i18n.t('receive.hintSparkLightning'))
  })

  // The code on screen is then an invoice good once, whatever address the wallet also has.
  it('stops promising anytime the moment an amount makes the code a one-off invoice', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
    const tree = await render()
    await enterAmount(tree, 5000)
    expect(texts(tree)).toContain(i18n.t('receive.hintInvoice'))
    expect(texts(tree)).not.toContain(i18n.t('receive.hintSparkLightning'))
  })

  it('says a Spark request with an amount is for one payment, and the address is not', async () => {
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    expect(texts(tree)).toContain(i18n.t('receive.hintSpark'))

    await enterAmount(tree, 5000)

    expect(texts(tree)).toContain(i18n.t('receive.hintInvoice'))
    expect(texts(tree)).not.toContain(i18n.t('receive.hintSpark'))
  })

  it('says the same of an invoice with an amount and no address', async () => {
    const tree = await render()
    await enterAmount(tree, 5000)
    expect(texts(tree)).toContain(i18n.t('receive.hintInvoice'))
    expect(texts(tree)).not.toContain(i18n.t('receive.hintSparkLightning'))
  })

  it('promises nothing while the read is in flight, and an amount needs no wait to be an invoice', async () => {
    jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise(() => undefined))
    const tree = await render()
    expect(texts(tree)).not.toContain(i18n.t('receive.hintSparkLightning'))
    expect(texts(tree)).not.toContain(i18n.t('receive.hintInvoice'))

    await enterAmount(tree, 5000)
    expect(texts(tree)).toContain(i18n.t('receive.hintInvoice'))
  })
})

// The address read answers late, so the rail left behind can still answer while it is awaited.
describe('while the address is being read', () => {
  type Addr = typeof ALICE | null
  let answer: (addr: Addr) => void
  beforeEach(() => {
    jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise<Addr>(resolve => (answer = resolve)))
  })
  const answerWith = async (addr: Addr) => {
    await ReactTestRenderer.act(async () => {
      answer(addr)
    })
    await flush()
  }

  it('shows the skeleton, asks for no invoice, and keeps More options on screen', async () => {
    const tree = await render()

    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
    expect(sparkReceive).not.toHaveBeenCalled()
    expect(moreOptions(tree)).toBeDefined()
  })

  it('a code from the rail left behind never stands in for the address', async () => {
    jest
      .mocked(sparkReceive)
      .mockImplementation(async method => ({ destination: `${method}-code`, feeSat: 0 }))
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    expect(texts(tree).join('').replace(/\s/g, '')).toContain('spark-code')

    await openRail(tree, i18n.t('receive.optionLightning'))

    expect(texts(tree).join('').replace(/\s/g, '')).not.toContain('spark-code')
    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  })

  it('a late answer from the rail left behind never stands in for the address', async () => {
    type Quote = { destination: string; feeSat: number }
    let late: ((q: Quote) => void) | undefined
    jest
      .mocked(sparkReceive)
      .mockImplementation(
        () => new Promise<Quote>(resolve => (late = resolve)) as ReturnType<typeof sparkReceive>,
      )
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    await openRail(tree, i18n.t('receive.optionLightning'))

    await ReactTestRenderer.act(async () => {
      late?.({ destination: 'spark1late', feeSat: 0 })
    })
    await flush()

    expect(texts(tree).join('').replace(/\s/g, '')).not.toContain('spark1late')
    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  })

  it('a late failure from the rail left behind does not cover the address', async () => {
    let fail: ((err: Error) => void) | undefined
    jest
      .mocked(sparkReceive)
      .mockImplementation(
        () => new Promise((_, reject) => (fail = reject)) as ReturnType<typeof sparkReceive>,
      )
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    await openRail(tree, i18n.t('receive.optionLightning'))

    await ReactTestRenderer.act(async () => {
      fail?.(new Error('nope'))
    })
    await flush()
    expect(texts(tree)).not.toContain(i18n.t('receive.failed'))

    await answerWith(ALICE)

    expect(texts(tree)).not.toContain(i18n.t('receive.failed'))
    expect(texts(tree).join('')).toContain('alice@breez.tips')
  })

  it('an address that lands after a tap to the on-chain rail changes nothing there', async () => {
    jest
      .mocked(sparkReceive)
      .mockImplementation(async method =>
        method === 'onchain'
          ? { destination: 'bc1qaddr', feeSat: 0 }
          : { destination: 'sp1sparkaddr', feeSat: 0 },
      )
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionBitcoin'))

    await answerWith(ALICE)

    expect(texts(tree).join('')).not.toContain('alice@breez.tips')
    expect(tree.root.findAllByType(QRCode)[0].props.value).toBe('bitcoin:bc1qaddr?spark=sp1sparkaddr')
  })
})

test('a Lightning amount regenerates the invoice for that value', async () => {
  const tree = await render()
  jest.mocked(sparkReceive).mockClear()

  await enterAmount(tree, 5000)

  expect(sparkReceive).toHaveBeenCalledWith('lightning', 5000, undefined, undefined)
})

test('a Spark amount bills a Spark invoice locked to it, not the static address', async () => {
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  jest.mocked(sparkReceive).mockClear()

  await enterAmount(tree, 5000)

  expect(sparkReceive).toHaveBeenCalledWith('spark', 5000, undefined, undefined)
})

test('a Lightning amount shows the ≈ fiat line; the amountless address does not', async () => {
  // A rate is available, so the negative assertion below cannot pass for lack of one.
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
  const tree = await render()

  expect(texts(tree).some(t => t.trimStart().startsWith('≈'))).toBe(false)

  await enterAmount(tree, 5000)
  expect(texts(tree).some(t => t.trimStart().startsWith('≈'))).toBe(true)
})

// The sats figure is worded by the locale, as every other amount on the screen is.
test('an amount in sats is worded by the locale', async () => {
  const raw = i18n.getResource('en-US', 'translation', 'receive.sats') as string
  i18n.addResource('en-US', 'translation', 'receive.sats', 'S {{amount}}')
  try {
    const tree = await render()
    await enterAmount(tree, 5000)
    expect(texts(tree)).toContain(`S ${formatSats(5000)}`)
  } finally {
    i18n.addResource('en-US', 'translation', 'receive.sats', raw)
  }
})

test('adding an amount switches the Lightning rail from the @ to a one-off invoice', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1invoice', feeSat: 0 })
  const tree = await render()

  await enterAmount(tree, 5000)

  expect(sparkReceive).toHaveBeenCalledWith('lightning', 5000, undefined, undefined)
  expect(texts(tree).join('')).toContain('lnbc1invoice')
})

test('the @ is a Lightning affordance: hidden on the on-chain rail', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  jest
    .mocked(sparkReceive)
    .mockImplementation(async method =>
      method === 'onchain'
        ? { destination: 'bc1qaddr', feeSat: 0 }
        : { destination: 'lnbc1inv', feeSat: 0 },
    )
  const tree = await render()

  await openRail(tree, i18n.t('receive.optionBitcoin'))

  expect(texts(tree).join('')).not.toContain('alice@breez.tips')
})

// --- Token billing (Spark invoice) ---

test('billing in USDB scales the typed amount to the token base units', async () => {
  const tree = await render()
  await pressRail(tree, 'Stablecoins')
  jest.mocked(sparkReceive).mockClear()
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'sparkinvoice1usdb', feeSat: 0 })

  // 1.5 USDB at 6 decimals is 1_500_000 base units, and passing 1.5 through bills a millionth of it.
  await enterAmount(tree, 1.5)

  expect(sparkReceive).toHaveBeenCalledWith('spark', 1_500_000n, undefined, USDB.identifier)
  expect(texts(tree).join('').replace(/\s/g, '')).toContain('sparkinvoice1usdb')
})

// USDB exists on Spark alone, so the stable side opens on it with no network to read or choose, and
// on the static address, which needs no amount.
test('the stable side opens on USDB and its Spark address, asking for nothing', async () => {
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'sp1staticaddress', feeSat: 0 })
  const tree = await render()
  await pressRail(tree, 'Stablecoins')

  // The static address receives bitcoin and every token alike, so no call ever carries the token.
  expect(texts(tree).join('').replace(/\s/g, '')).toContain('sp1staticaddress')
  for (const call of jest.mocked(sparkReceive).mock.calls) {
    expect(call[3]).toBeUndefined()
  }
  expect(tree.root.findAllByType(AmountSheet).some(n => n.props.visible)).toBe(false)
  const shown = texts(tree).join(' ')
  expect(shown).toContain('USDB')
  expect(shown).not.toContain(i18n.t('receive.stableNetwork'))
})

test('leaving the stable side drops the token: a bolt11 invoice cannot carry one', async () => {
  const tree = await render()
  await pressRail(tree, 'Stablecoins')
  await enterAmount(tree, 2)
  jest.mocked(sparkReceive).mockClear()
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1forsats', feeSat: 0 })

  await pressRail(tree, 'Bitcoin')
  // A fresh value, so the answer cannot come from the cache.
  await enterAmount(tree, 7000)

  expect(sparkReceive).toHaveBeenCalledWith('lightning', 7000, undefined, undefined)
  for (const call of jest.mocked(sparkReceive).mock.calls) {
    expect(call[3]).toBeUndefined()
  }
})

// With no rail selector on the Bitcoin side, a Spark rail left over from the tokens would have no way out.
test('going back to Bitcoin lands on Lightning with the Bitcoin asset', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
  const tree = await render()
  await pressRail(tree, 'Stablecoins')
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'sparkinvoice1usdb', feeSat: 0 })
  await enterAmount(tree, 5)
  expect(texts(tree).join('').replace(/\s/g, '')).toContain('sparkinvoice1usdb')

  // The cache key carries the token, so a QR billing 5 USDB cannot survive the switch back to Bitcoin.
  await pressRail(tree, 'Bitcoin')

  expect(texts(tree).join('').replace(/\s/g, '')).not.toContain('sparkinvoice1usdb')
  expect(texts(tree).join('')).toContain('alice@breez.tips')
  expect(tree.root.findAllByType(QRCode)[0].props.value).toBe('lnurl1abc')

  // The amount sheet speaks sats again, so the asset came back as well as the rail.
  expect(tree.root.findByType(AmountSheet).props.unit).toBe('sats')
})

test('Bitcoin reopens on Lightning from the Spark rail too, leaving no token behind', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 0,
    tokens: [{ identifier: 'btkn1brla', ticker: 'BRLA', name: 'Spark BRL', decimals: 6, balanceBaseUnits: 0 }],
  })
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect('btkn1brla'))
  await flush()

  await pressRail(tree, 'Stablecoins')
  await pressRail(tree, 'Bitcoin')

  expect(texts(tree).join('')).toContain('alice@breez.tips')
  expect(tree.root.findByType(AmountSheet).props.unit).toBe('sats')
})

test('leaving the Spark rail through More options drops the token as well', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 0,
    tokens: [{ identifier: 'btkn1brla', ticker: 'BRLA', name: 'Spark BRL', decimals: 6, balanceBaseUnits: 0 }],
  })
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect('btkn1brla'))
  await flush()
  await enterAmount(tree, 3)

  await openRail(tree, i18n.t('receive.optionLightning'))
  jest.mocked(sparkReceive).mockClear()
  await enterAmount(tree, 7000)

  expect(jest.mocked(sparkReceive).mock.lastCall).toEqual(['lightning', 7000, undefined, undefined])
})

// A double carries about 15 significant digits, so a token at 18 places typed as 1.000000000000000001
// would be billed as 1 if the figure passed through one. Six places are the control.
describe('a typed token amount is billed as typed', () => {
  const EIGHTEEN = { identifier: 'btkn1eighteen', ticker: 'EIGHT', name: 'Eighteen', decimals: 18, balanceBaseUnits: 0 }
  const SIX = { identifier: 'btkn1six', ticker: 'SIX', name: 'Six', decimals: 6, balanceBaseUnits: 0 }

  it.each([
    [18, EIGHTEEN, '1.000000000000000001', 1_000_000_000_000_000_001n, '1.000000000000000001 EIGHT'],
    [6, SIX, '1.000001', 1_000_001n, '1.000001 SIX'],
  ])('at %i places: exactly the base units typed, and the figure drawn is the one typed', async (_places, token, typed, base, drawn) => {
    mockRouteParams = { assetId: token.identifier }
    jest.mocked(sparkGetWalletInfo).mockResolvedValue({
      sync: 'synced' as const,
      recoverableSat: 0,
      balanceSat: 0,
      tokens: [token],
    })
    const tree = await render()
    await enterAmount(tree, typed)

    expect(sparkReceive).toHaveBeenLastCalledWith('spark', base, undefined, token.identifier)
    expect(texts(tree)).toContain(drawn)
  })
})

// A token never rides Lightning, so the default rail must not catch a screen opened for one.
describe('opened from a token with no peg', () => {
  const BRLA = { identifier: 'btkn1brla', ticker: 'BRLA', name: 'Spark BRL', decimals: 6, balanceBaseUnits: 0 }
  const wallet = { sync: 'synced' as const, recoverableSat: 0, balanceSat: 0, tokens: [BRLA] }

  it('lands on the Spark rail with the token chosen, and bills in it', async () => {
    mockRouteParams = { assetId: BRLA.identifier }
    jest.mocked(sparkGetWalletInfo).mockResolvedValue(wallet)

    const tree = await render()

    expect(sparkReceive).toHaveBeenCalledWith('spark', undefined, undefined, undefined)
    expect(tree.root.findByType(AmountSheet).props.unit).toBe('BRLA')
    await enterAmount(tree, 2)
    expect(sparkReceive).toHaveBeenCalledWith('spark', 2_000_000n, undefined, BRLA.identifier)
    expect(sparkReceive).not.toHaveBeenCalledWith('lightning', undefined, undefined, undefined)
  })

  it('mints no invoice while the wallet read that names the token is in flight', async () => {
    mockRouteParams = { assetId: BRLA.identifier }
    let answer: (info: typeof wallet) => void = () => undefined
    jest.mocked(sparkGetWalletInfo).mockReturnValue(
      new Promise(resolve => (answer = resolve)) as ReturnType<typeof sparkGetWalletInfo>,
    )

    await render()
    await ReactTestRenderer.act(async () => answer(wallet))
    await flush()

    expect(jest.mocked(sparkReceive).mock.calls.map(call => call[0])).not.toContain('lightning')
  })

  // The read that names the token can land after the person picked a rail.
  it.each([
    ['with no peg', BRLA],
    ['with a peg', { ...BRLA, identifier: USDB.identifier, ticker: 'USDB', name: 'USDB' }],
  ])('a Lightning pick before the read that names a token %s never bills it on Lightning', async (_kind, token) => {
    mockRouteParams = { assetId: token.identifier }
    let answer: (info: typeof wallet) => void = () => undefined
    jest.mocked(sparkGetWalletInfo).mockReturnValue(
      new Promise(resolve => (answer = resolve)) as ReturnType<typeof sparkGetWalletInfo>,
    )

    const tree = await render()
    await openRail(tree, i18n.t('receive.optionLightning'))
    await ReactTestRenderer.act(async () => answer({ ...wallet, tokens: [token] }))
    await flush()
    await enterAmount(tree, 2)

    expect(sparkReceive).toHaveBeenCalledWith('spark', 2_000_000n, undefined, token.identifier)
    expect(jest.mocked(sparkReceive).mock.calls.filter(call => call[0] === 'lightning' && call[3] !== undefined)).toEqual([])
  })

  it('stays on Spark when the wallet read fails and the token is never named', async () => {
    mockRouteParams = { assetId: BRLA.identifier }
    jest.mocked(sparkGetWalletInfo).mockRejectedValue(new Error('offline'))
    jest.mocked(sparkReceive).mockResolvedValue({ destination: 'spark1any', feeSat: 0 })

    const tree = await render()

    expect(jest.mocked(sparkReceive).mock.calls.map(call => call[0])).toEqual(['spark'])
    expect(texts(tree).join('').replace(/\s/g, '')).toContain('spark1any')
  })

  it("Bitcoin's own screen still opens on Lightning", async () => {
    mockRouteParams = { assetId: BITCOIN_ASSET_ID }
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ALICE)

    const tree = await render()

    expect(texts(tree).join('')).toContain('alice@breez.tips')
  })
})

describe('Copy and Share, the two ways the address leaves the screen', () => {
  const PADARIA = {
    address: 'padaria@usevoltz.app',
    username: 'padaria',
    lnurl: 'lnurl1padaria',
  } as never

  it('keeps both under the code, and off until a code is on screen', async () => {
    jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise(() => undefined))
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' })
    const tree = await render()

    await pressAction(tree, i18n.t('receive.copy'))
    await pressAction(tree, i18n.t('receive.share'))

    expect(action(tree, i18n.t('receive.copy')).props.disabled).toBe(true)
    expect(action(tree, i18n.t('receive.share')).props.disabled).toBe(true)
    expect(Clipboard.setString).not.toHaveBeenCalled()
    expect(share).not.toHaveBeenCalled()
    share.mockRestore()
  })

  it('takes both away with a failed code, which has nothing to hand over', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
    jest.mocked(sparkReceive).mockRejectedValue(new Error('offline'))
    const tree = await render()

    expect(texts(tree)).toContain(i18n.t('receive.failed'))
    expect(texts(tree)).not.toContain(i18n.t('receive.copy'))
    expect(texts(tree)).not.toContain(i18n.t('receive.share'))
  })

  it('copies the lightning address, which is what a paste field takes', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(PADARIA)
    const tree = await render()

    await pressAction(tree, i18n.t('receive.copy'))

    expect(Clipboard.setString).toHaveBeenLastCalledWith('padaria@usevoltz.app')
  })

  // The name reads in a chat, and the LNURL reaches a wallet with no lightning addresses.
  it('shares the lightning address with its LNURL, the name first', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(PADARIA)
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' })
    const tree = await render()

    await pressAction(tree, i18n.t('receive.share'))

    expect(share).toHaveBeenCalledWith({ message: 'padaria@usevoltz.app\nlnurl1padaria' })
    share.mockRestore()
  })

  it('shares a one-off invoice as it is', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' })
    const tree = await render()

    await pressAction(tree, i18n.t('receive.share'))

    expect(share).toHaveBeenCalledWith({ message: 'lnbc1default' })
    share.mockRestore()
  })

  it('stays on the screen when the share sheet refuses', async () => {
    const share = jest.spyOn(Share, 'share').mockRejectedValue(new Error('no sheet'))
    const tree = await render()

    await pressAction(tree, i18n.t('receive.share'))
    await flush()

    expect(share).toHaveBeenCalledTimes(1)
    expect(texts(tree).join('')).toContain('lnbc1default')
    share.mockRestore()
  })

  it('leaves the header empty on a rail that has the buttons', async () => {
    await render()
    expect(mockSetOptions.mock.lastCall?.[0].headerRight()).toBeUndefined()
  })

  // The cross-chain panel draws no buttons of its own, and an expired quote hands up null.
  it('shares from the header on the cross-chain side, and only what the panel hands up', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' })
    const tree = await render()
    await pressRail(tree, 'Stablecoins')
    await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect('USDT'))

    const panel = tree.root.findByType(StableReceivePanel)
    await ReactTestRenderer.act(async () => panel.props.onShareable(null))
    expect(mockSetOptions.mock.lastCall?.[0].headerRight()).toBeUndefined()

    await ReactTestRenderer.act(async () => panel.props.onShareable('Send 10 USDT\nTaddr'))
    const headerRight = mockSetOptions.mock.lastCall?.[0].headerRight as () => React.JSX.Element
    expect(headerRight().props.accessibilityRole).toBe('button')
    expect(headerRight().props.accessibilityLabel).toBe(i18n.t('receive.share'))
    await ReactTestRenderer.act(async () => headerRight().props.onPress())

    expect(share).toHaveBeenCalledWith({ message: 'Send 10 USDT\nTaddr' })
    share.mockRestore()
  })

  it('reads the address out as text, now that the address is not a control', async () => {
    const tree = await render()
    expect(tree.root.findAll(n => n.props.accessibilityLabel === i18n.t('receive.copyAddress', { address: 'lnbc1default' }))).toEqual([])
    expect(texts(tree).join('')).toContain('lnbc1default')
  })

  it('confirms the copy in words, and says it to a screen reader', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    const tree = await render()
    expect(texts(tree)).not.toContain(i18n.t('receive.copied'))

    await pressAction(tree, i18n.t('receive.copy'))

    expect(texts(tree)).toContain(i18n.t('receive.copied'))
    expect(announce).toHaveBeenCalledWith(i18n.t('receive.copied'))
    announce.mockRestore()
  })

  // A label left over from another code would say the code on screen is on the clipboard.
  it('drops the confirmation the moment the code on screen is another one', async () => {
    const tree = await render()
    await pressAction(tree, i18n.t('receive.copy'))
    expect(texts(tree)).toContain(i18n.t('receive.copied'))

    jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1withamount', feeSat: 0 })
    await enterAmount(tree, 5000)

    expect(texts(tree)).not.toContain(i18n.t('receive.copied'))
    expect(texts(tree)).toContain(i18n.t('receive.copy'))
  })
})

it('names the asset the Spark rail will bill in, since that row is how it gets changed', async () => {
  // A token other than USDB keeps the row on the Bitcoin side; USDB is chosen on the dollar side.
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 0,
    tokens: [{ identifier: 'btkn1brla', ticker: 'BRLA', name: 'Spark BRL', decimals: 6, balanceBaseUnits: 0 }],
  })
  // Read inside the row, not across the screen. "Bitcoin" is also a tab's label, so asking the whole
  // tree passed with the row blanked, which is the test passing on somebody else's text.
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  // The label carries the choice too, since a button label replaces its text for a screen reader.
  const row = tree.root.find(
    n =>
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityLabel === `Bitcoin, ${i18n.t('receive.chooseAsset')}`,
  )
  expect(row.findAllByType(Text).map(n => String(n.props.children))).toContain('Bitcoin')
  const listed = tree.root.findByType(AssetPickerSheet).props.items.map((i: { ticker: string }) => i.ticker)
  expect(listed).not.toContain('USDB')
})

// The list opens on the asset the invoice is billed in, and follows a new choice.
it('the asset list marks the asset the receive bills in, then the one picked', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({
    sync: 'synced',
    recoverableSat: 0,
    balanceSat: 0,
    tokens: [{ identifier: 'btkn1brla', ticker: 'BRLA', name: 'Spark BRL', decimals: 6, balanceBaseUnits: 0 }],
  })
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  const row = () =>
    tree.root.find(
      n =>
        typeof n.props.onPress === 'function' &&
        String(n.props.accessibilityLabel).endsWith(`, ${i18n.t('receive.chooseAsset')}`),
    )
  await ReactTestRenderer.act(async () => row().props.onPress())
  expect(markedInOpenPicker(tree.root)).toEqual([BITCOIN_ASSET_ID])

  await ReactTestRenderer.act(async () => tree.root.findByType(AssetPickerSheet).props.onSelect('btkn1brla'))
  expect(row().props.accessibilityLabel).toBe(`BRLA, ${i18n.t('receive.chooseAsset')}`)
  await ReactTestRenderer.act(async () => row().props.onPress())
  expect(markedInOpenPicker(tree.root)).toEqual(['btkn1brla'])
})

// With only Bitcoin left to bill in, a row offering a choice of one is not drawn.
it('the Bitcoin side has no asset row when bitcoin is all it can bill', async () => {
  const tree = await render()
  await openRail(tree, i18n.t('receive.optionSpark'))
  const rows = tree.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      String(n.props.accessibilityLabel).endsWith(i18n.t('receive.chooseAsset')),
  )
  expect(rows).toHaveLength(0)
})

describe('DePix', () => {
  // Token lists belong to the wallet in front.
  const addDepix = async () => {
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/wallets.json`, JSON.stringify({ active: 'w_test', wallets: [{ id: 'w_test', fingerprint: 'fp-test' }] }), 'utf8')
    await addToken({ identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals })
  }
  const assetRow = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root.findAll(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === `${label}, ${i18n.t('receive.chooseAsset')}`,
    )

  // A pegged token is a stablecoin, so an added DePix sits with USDB on the stable side, billable
  // before the wallet holds any, and the Bitcoin side keeps only bitcoin.
  it('an added DePix is offered among the stablecoins, not on the Bitcoin side', async () => {
    await addDepix()
    const tree = await render()
    await openRail(tree, i18n.t('receive.optionSpark'))
    expect(assetRow(tree, 'Bitcoin')).toHaveLength(0)
    await pressRail(tree, 'Stablecoins')
    const listed = tree.root.findByType(AssetPickerSheet).props.items.map((i: { ticker: string }) => i.ticker)
    // The dollars together, then the real.
    expect(listed).toEqual(['USDB', 'USDT', 'USDC', 'DePix'])
  })

  // A token lives on Spark alone, so its network is not a thing to read on the first level.
  it('a Spark stablecoin has no network row', async () => {
    const tree = await render()
    await pressRail(tree, 'Stablecoins')
    expect(tree.root.findAll(n => n.props.assetId === 'chain:spark')).toHaveLength(0)
    expect(texts(tree)).not.toContain(i18n.t('receive.stableNetwork'))
  })

  it('the stablecoins list DePix only once it is on the wallet list', async () => {
    const tree = await render()
    await pressRail(tree, 'Stablecoins')
    const listed = tree.root.findByType(AssetPickerSheet).props.items.map((i: { ticker: string }) => i.ticker)
    expect(listed).toEqual(['USDB', 'USDT', 'USDC'])
  })

  it("opened from DePix's own screen, the receive lands on the Spark rail with DePix chosen", async () => {
    await addDepix()
    mockRouteParams = { assetId: DEPIX.identifier }
    const tree = await render()
    expect(assetRow(tree, 'DePix')).toHaveLength(1)
  })
})

describe('display currency', () => {
  // A device in Brazil, so the region default (BRL) and the saved choice differ. Rates put 2,000 sats
  // at R$ 11.00 and € 1.80, and only the coins asked for are answered, as sparkGetFiatRates does.
  const RATES: Record<string, number> = { BRL: 550_000, EUR: 90_000 }
  beforeEach(() => {
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
  })

  // The figure is drawn for a Lightning amount, the rail whose amount is always in sats.
  async function fiatLines(): Promise<string[]> {
    const tree = await render()
    await enterAmount(tree, 2000)
    return texts(tree).filter(s => s.trimStart().startsWith('≈'))
  }

  // Nothing else in a fresh process has configured the formatter, so the symbol is there only when
  // the screen loads the SDK's list itself.
  test('a saved currency beyond BRL and USD shows its symbol, not its bare code', async () => {
    jest
      .mocked(sparkListFiatCurrencies)
      .mockResolvedValue([{ id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }])
    await saveDisplayCurrency('EUR')

    expect(await fiatLines()).toEqual(['≈ €1.80'])
  })

  test('with nothing saved the figure is in the device region currency', async () => {
    expect(await fiatLines()).toEqual(['≈ R$11.00'])
  })
})

describe('the enlarged code', () => {
  // The code reports where it sits on screen, which the zoom flies from. Under Jest a View is a mock
  // whose native methods do nothing, so the code's own one answers here.
  async function renderMeasured(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    tree.root
      .findAll(n => n.props.accessibilityLabel === i18n.t('receive.enlargeQr'))
      .forEach(node => {
        const host = node.instance as { measureInWindow?: unknown } | null
        if (host && typeof host.measureInWindow === 'function') {
          host.measureInWindow = (cb: (x: number, y: number, width: number) => void) => cb(10, 20, 200)
        }
      })
    return tree
  }
  const qrButton = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.find(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('receive.enlargeQr'),
    )

  it('is opened from the code, a button that says it enlarges it', async () => {
    const tree = await renderMeasured()
    expect(qrButton(tree).props.accessibilityRole).toBe('button')
  })

  it('closes from a backdrop a screen reader announces as a button', async () => {
    const tree = await renderMeasured()
    await ReactTestRenderer.act(async () => qrButton(tree).props.onPress())
    await flush()
    const backdrop = tree.root.find(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('common.close'),
    )
    expect(backdrop.props.accessibilityRole).toBe('button')
  })

  // Under reduced motion the code fades in where the enlarged one is drawn, and never flies there.
  describe('with reduced motion', () => {
    const zoomCard = (tree: ReactTestRenderer.ReactTestRenderer) => {
      const qr = tree.root.findAll(n => n.type === QRCode && n.props.size === 300)
      expect(qr).toHaveLength(1)
      return StyleSheet.flatten(qr[0]!.parent!.props.style)
    }
    afterEach(() => {
      jest.restoreAllMocks()
    })

    it.each([
      [true, 'fades in place'],
      [false, 'flies from the code'],
    ])('reduced %s: the enlarged code %s', async (reduced, _what) => {
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
      const tree = await renderMeasured()
      await ReactTestRenderer.act(async () => qrButton(tree).props.onPress())
      await flush()
      const card = zoomCard(tree)
      if (reduced) {
        expect(card.transform).toBeUndefined()
      } else {
        expect((card.transform as object[]).map(step => Object.keys(step)[0])).toEqual([
          'translateX',
          'translateY',
          'scale',
        ])
      }
      // The fade stays either way: the backdrop that holds the card follows the same value.
      const backdrop = tree.root.find(
        n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('common.close'),
      )
      expect(StyleSheet.flatten(backdrop.parent!.props.style).opacity).toBeDefined()
    })
  })

  // The window is read when the zoom opens, not when the app started, so a rotation or a resized
  // split screen still flies the code from where it sits.
  it('flies from the code in the window as it is now', async () => {
    const { Dimensions } = require('react-native')
    const before = Dimensions.get('window')
    const tree = await renderMeasured()
    try {
      await ReactTestRenderer.act(async () => {
        Dimensions.set({ window: { ...before, width: 1000, height: 700 } })
      })
      await ReactTestRenderer.act(async () => qrButton(tree).props.onPress())
      await flush()
      const card = tree.root.find(
        n => Array.isArray(n.props.style) && n.props.style.some((part: { transform?: unknown }) => part?.transform),
      )
      const [translateX, translateY] = (
        card.props.style.find((part: { transform?: unknown }) => part?.transform).transform as Array<
          Record<string, { __getValue?: unknown; _config?: { outputRange: number[] } }>
        >
      ).map(step => Object.values(step)[0]._config?.outputRange[0])
      expect(translateX).toBe(10 + 100 - 500)
      expect(translateY).toBe(20 + 100 - 350)
    } finally {
      Dimensions.set({ window: before })
    }
  })
})

describe('asking for an amount on a dollar wallet', () => {
  const sheet = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(AmountSheet)
  const openSheet = async (tree: ReactTestRenderer.ReactTestRenderer): Promise<void> => {
    await ReactTestRenderer.act(async () => {
      tree.root
        .findAll(node => typeof node.props.onPress === 'function')
        .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('receive.addAmount')))
        ?.props.onPress()
    })
    await flush()
  }

  beforeEach(() => {
    jest.mocked(useDollarMode).mockReturnValue(true)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000, USD: 100_000 })
  })

  afterEach(() => {
    jest.mocked(useDollarMode).mockReturnValue(false)
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
  })

  test('the sheet opens in dollars even to someone reading reais, and the SDK gets sats', async () => {
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    const tree = await render()
    await openSheet(tree)

    expect(sheet(tree).props.initialDenom).toBe('fiat')
    expect(sheet(tree).props.fiatCurrency).toBe('USD')
    expect(sheet(tree).props.fiatRate).toBe(100_000)

    jest.mocked(sparkReceive).mockClear()
    await ReactTestRenderer.act(async () => {
      sheet(tree).props.onConfirm(10_000, 'fiat')
    })
    await flush()

    expect(sparkReceive).toHaveBeenCalledWith('lightning', 10_000, undefined, undefined)
  })

  test('the amount asked for in dollars carries ≈, with the sats beneath', async () => {
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    const tree = await render()
    await openSheet(tree)
    await ReactTestRenderer.act(async () => {
      sheet(tree).props.onConfirm(10_000, 'fiat')
    })
    await flush()

    expect(texts(tree)).toContain('≈ $10.00')
    expect(texts(tree)).toContain(`${formatSats(10_000)} sats`)
    expect(texts(tree).join(' ')).not.toContain('R$')
  })

  test('a dollar amount is never priced at the rate of reais', async () => {
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    const tree = await render()
    await openSheet(tree)
    await ReactTestRenderer.act(async () => {
      sheet(tree).props.onConfirm(10_000, 'fiat')
    })
    await flush()

    // The mode going off drops the dollar figure's own lines, and what stays is still that figure.
    jest.mocked(useDollarMode).mockReturnValue(false)
    await ReactTestRenderer.act(async () => {
      tree.update(<ReceiveSpark />)
    })
    await flush()

    expect(texts(tree)).toContain('≈ $10.00')
    expect(texts(tree).join(' ')).not.toContain('$55')
  })

  test('with no dollar rate the sheet opens in sats and works', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ BRL: 550_000 })
    const tree = await render()
    await openSheet(tree)

    expect(sheet(tree).props.initialDenom).toBeUndefined()
    expect(sheet(tree).props.fiatRate).toBeUndefined()
  })

  test('a rate that lands with the sheet open waits for the next opening', async () => {
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    let land: (rates: Record<string, number>) => void = () => undefined
    jest.mocked(sparkGetFiatRates).mockReturnValue(new Promise(resolve => (land = resolve)))
    const tree = await render()
    await openSheet(tree)

    await ReactTestRenderer.act(async () => {
      land({ BRL: 550_000, USD: 100_000 })
    })
    await flush()

    expect(sheet(tree).props.initialDenom).toBeUndefined()
    expect(sheet(tree).props.fiatCurrency).toBe('BRL')
    expect(sheet(tree).props.fiatRate).toBe(550_000)
  })

  test('a token keeps its own unit', async () => {
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(SegmentedControl).props.onChange('stable')
    })
    await flush()

    expect(sheet(tree).props.initialDenom).toBeUndefined()
    expect(sheet(tree).props.fiatRate).toBeUndefined()
  })
})

test('a value typed in a currency keeps the rate it was typed at, whatever arrives after', async () => {
  jest.mocked(useDollarMode).mockReturnValue(false)
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('receive.addAmount')))
      ?.props.onPress()
  })
  await flush()
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(AmountSheet).props.onConfirm(10_000, 'fiat')
  })
  await flush()

  expect(texts(tree)).toContain('$10.00')
  jest.mocked(sparkGetFiatRates).mockResolvedValue({})
})

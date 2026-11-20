import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { ScrollView, Text, View } from 'react-native'
import i18n from '../src/i18n'
import { RedeemSpark } from '../src/screens/RedeemSpark'
import { AmountSheet } from '../src/components/AmountSheet'
import { GradientButton } from '../src/components/GradientButton'
import { Screen } from '../src/components/Screen'
import { Skeleton } from '../src/components/Skeleton'
import {
  sparkParseLnurlWithdraw,
  sparkConfirmLnurlWithdraw,
  sparkGetFiatRates,
  sparkListFiatCurrencies,
} from '../src/wallet/spark'
import { formatSats } from '../src/wallet/amount'
import { ReceiveHeldByExit } from '../src/wallet/errors'
import { alpha } from '../src/theme'
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

jest.mock('../src/wallet/spark', () => ({
  sparkParseLnurlWithdraw: jest.fn(),
  sparkConfirmLnurlWithdraw: jest.fn(),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

const mockGoBack = jest.fn()
let mockParams: { destination?: string } = { destination: 'lnurl1wd' }
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn(), setOptions: jest.fn() }),
  useRoute: () => ({ params: mockParams }),
}))

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<RedeemSpark />)
  })
  await settle()
  return tree
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))

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

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getCurrencies).mockReturnValue(STOCK_DEVICE_CURRENCIES)
  mockParams = { destination: 'lnurl1wd' }
  jest.mocked(sparkParseLnurlWithdraw).mockResolvedValue({
    handle: 'wd1',
    minSat: 1000,
    maxSat: 50_000,
    description: 'Event voucher',
  })
  jest.mocked(sparkConfirmLnurlWithdraw).mockResolvedValue('pending')
})

test('parses the voucher and bounds the amount sheet by its range', async () => {
  const tree = await render()

  expect(sparkParseLnurlWithdraw).toHaveBeenCalledWith('lnurl1wd')
  const sheet = tree.root.findByType(AmountSheet)
  expect(sheet.props.visible).toBe(true)
  expect(sheet.props.min).toBe(1000)
  expect(sheet.props.max).toBe(50_000)
  // A range voucher leaves min and max apart, so the sheet opens empty for the amount to be picked.
  expect(sheet.props.initial).toBe('')
})

test('a fixed-value voucher (min === max) prefills the amount so the user just confirms', async () => {
  jest.mocked(sparkParseLnurlWithdraw).mockResolvedValue({
    handle: 'wd1',
    minSat: 5000,
    maxSat: 5000,
    description: 'Fixed voucher',
  })
  const tree = await render()

  expect(tree.root.findByType(AmountSheet).props.initial).toBe('5000')
})

test('choosing an amount then Redeem pulls it in and returns home', async () => {
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    tree.root.findByType(AmountSheet).props.onConfirm(5000)
  })
  await settle()

  expect(texts(tree).join(' ')).toContain('Event voucher')

  await pressBtn(tree, 'Redeem')

  expect(sparkConfirmLnurlWithdraw).toHaveBeenCalledWith('wd1', 5000)
  expect(mockGoBack).toHaveBeenCalled()
})

// As on Send's review, the action is the screen's footer, which stays in view above the bottom inset,
// rather than a row at the end of the scroll that a short screen leaves under the gesture bar.
test('the review\'s Redeem is the screen\'s footer, never a row at the end of the scroll', async () => {
  const tree = await render()
  // The footer is already there while the first amount sheet is open. Arriving with the amount, it
  // would change the screen's structure in the render that closes the sheet and remount the sheet
  // while it is still presented.
  expect(tree.root.findByType(AmountSheet).props.visible).toBe(true)
  expect(tree.root.findByType(Screen).props.footer).toBeTruthy()
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(AmountSheet).props.onConfirm(5000)
  })
  await settle()

  const redeem = (node: ReactTestRenderer.ReactTestInstance) =>
    node.findAllByType(GradientButton).filter(button => button.props.label === i18n.t('redeem.action')).length
  const screen = tree.root.findByType(Screen)
  expect(redeem(tree.root)).toBe(1)
  expect(redeem(screen.findAllByType(ScrollView)[0]!)).toBe(0)
})

test('opened with no code, it stops loading and says the code is not a voucher', async () => {
  mockParams = {}
  const tree = await render()
  expect(sparkParseLnurlWithdraw).not.toHaveBeenCalled()
  expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  expect(texts(tree)).toContain(i18n.t('redeem.parseFailed'))
})

test('a read that failed offers Try again, which reads the voucher anew', async () => {
  jest.mocked(sparkParseLnurlWithdraw).mockRejectedValueOnce(new Error('unreadable'))
  const tree = await render()
  expect(texts(tree)).toContain(i18n.t('redeem.parseFailed'))

  await pressBtn(tree, i18n.t('common.retry'))

  expect(sparkParseLnurlWithdraw).toHaveBeenCalledTimes(2)
  expect(texts(tree)).not.toContain(i18n.t('redeem.parseFailed'))
  expect(texts(tree)).not.toContain(i18n.t('common.retry'))
})

test('opened with no code, Try again has nothing to read and is not offered', async () => {
  mockParams = {}
  const tree = await render()
  expect(texts(tree)).not.toContain(i18n.t('common.retry'))
})

test('cancelling the amount sheet with no value leaves the screen', async () => {
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    tree.root.findByType(AmountSheet).props.onConfirm(undefined)
  })
  await settle()

  expect(mockGoBack).toHaveBeenCalled()
  expect(sparkConfirmLnurlWithdraw).not.toHaveBeenCalled()
})

test('a failed pull stays on the review and shows the error', async () => {
  jest.mocked(sparkConfirmLnurlWithdraw).mockResolvedValue('failed')
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    tree.root.findByType(AmountSheet).props.onConfirm(5000)
  })
  await settle()
  await pressBtn(tree, 'Redeem')

  expect(texts(tree).join(' ')).toContain('Could not redeem.')
  expect(mockGoBack).not.toHaveBeenCalled()
})

describe('the review, which is the last thing seen before the money moves', () => {
  // This is the screen that says how much a voucher is worth, and confirming it is what pulls the
  // funds, so the figure, its unit and its currency line are each pinned.
  async function reviewing(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkParseLnurlWithdraw).mockResolvedValue({
      handle: 'wd1',
      minSat: 5000,
      maxSat: 5000,
      description: 'Fixed voucher',
    })
    const tree = await render()
    const sheet = tree.root.findByType(AmountSheet)
    await ReactTestRenderer.act(async () => sheet.props.onConfirm('5000'))
    await settle()
    return tree
  }

  it('shows the amount with its unit beside it', async () => {
    const shown = texts(await reviewing())
    expect(shown.some(t => t.replace(/\s/g, '').includes(formatSats(5000).replace(/\s/g, '')))).toBe(true)
    expect(shown).toContain(i18n.t('common.sats'))
  })

  it('names the unit through i18n rather than writing it into the markup', async () => {
    // The word happens to be the same in all 24 locales, which is exactly why a literal " sats" in
    // the markup would go unnoticed the day it stops being.
    const shown = texts(await reviewing())
    expect(shown).toContain(i18n.t('common.sats'))
  })

  it('shows the same amount in the wallet currency when a rate is known', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 60000, BRL: 300000, EUR: 55000 })
    const shown = texts(await reviewing()).join(' ')
    expect(shown).toContain('≈')
  })

  it('says nothing about currency when no rate is known, rather than showing a zero', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})
    expect(texts(await reviewing()).join(' ')).not.toContain('≈')
  })

  describe('display currency', () => {
    // A device in Brazil, so the region default (BRL) and the saved choice differ. Rates put the
    // 5,000 sat voucher at R$ 27.50 and € 4.50, and only the coins asked for are answered, as
    // sparkGetFiatRates does.
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

    function fiatLines(tree: ReactTestRenderer.ReactTestRenderer): string[] {
      return texts(tree).filter(s => s.startsWith('≈ '))
    }

    // A voucher link can open the screen in a fresh process, before Home has loaded the SDK's
    // currency list, so the symbol is there only when this screen configures the formatter itself.
    it('a saved currency beyond BRL and USD draws its symbol, not its bare code', async () => {
      jest
        .mocked(sparkListFiatCurrencies)
        .mockResolvedValue([{ id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }])
      await saveDisplayCurrency('EUR')

      expect(fiatLines(await reviewing())).toEqual(['≈ €4.50'])
    })

    it('with nothing saved the line is in the device region currency', async () => {
      expect(fiatLines(await reviewing())).toEqual(['≈ R$27.50'])
    })
  })
})

// A ranged voucher's amount can change from the review without a second scan, and Redeem pays the
// last amount confirmed in the sheet, never an earlier one.
describe('changing the amount from the review', () => {
  async function confirmed(value: number): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(value)
    })
    await settle()
    return tree
  }

  const changeLink = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.label === 'string')
      .find(n => (n.props.label as string).endsWith(i18n.t('redeem.changeAmount')))

  it('reopens the sheet on the voucher range with the confirmed amount in it', async () => {
    const tree = await confirmed(1000)
    expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)

    await ReactTestRenderer.act(async () => changeLink(tree)!.props.onPress())
    const sheet = tree.root.findByType(AmountSheet)
    expect(sheet.props.visible).toBe(true)
    expect(sheet.props.min).toBe(1000)
    expect(sheet.props.max).toBe(50_000)
    expect(sheet.props.initial).toBe('1000')
  })

  it('pays the amount confirmed last', async () => {
    const tree = await confirmed(1000)
    await ReactTestRenderer.act(async () => changeLink(tree)!.props.onPress())
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(2000)
    })
    await settle()
    expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)

    await pressBtn(tree, 'Redeem')
    expect(sparkConfirmLnurlWithdraw).toHaveBeenCalledTimes(1)
    expect(sparkConfirmLnurlWithdraw).toHaveBeenCalledWith('wd1', 2000)
  })

  it('keeps the confirmed amount when the reopened sheet is closed, and stays on the review', async () => {
    const tree = await confirmed(1000)
    await ReactTestRenderer.act(async () => changeLink(tree)!.props.onPress())
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onClose()
    })
    await settle()
    expect(mockGoBack).not.toHaveBeenCalled()

    await pressBtn(tree, 'Redeem')
    expect(sparkConfirmLnurlWithdraw).toHaveBeenCalledWith('wd1', 1000)
  })

  it('keeps the confirmed amount when the reopened sheet is confirmed empty', async () => {
    const tree = await confirmed(1000)
    await ReactTestRenderer.act(async () => changeLink(tree)!.props.onPress())
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(undefined)
    })
    await settle()
    expect(mockGoBack).not.toHaveBeenCalled()

    await pressBtn(tree, 'Redeem')
    expect(sparkConfirmLnurlWithdraw).toHaveBeenCalledWith('wd1', 1000)
  })

  // errors.lnurlRefused speaks of a recipient, which on a voucher is this wallet.
  it('a voucher service that refuses reads as a failed claim', async () => {
    jest.mocked(sparkConfirmLnurlWithdraw).mockRejectedValue(
      Object.assign(new Error('SdkError.LnurlError'), {
        tag: 'LnurlError',
        inner: Object.freeze(['endpoint error: voucher already used']),
      }),
    )
    const tree = await confirmed(1000)
    await pressBtn(tree, 'Redeem')

    expect(texts(tree)).toContain(i18n.t('redeem.failed'))
    expect(texts(tree)).not.toContain(i18n.t('errors.lnurlRefused'))
  })

  it('drops a failed attempt\'s error once a new amount is chosen', async () => {
    jest.mocked(sparkConfirmLnurlWithdraw).mockResolvedValue('failed')
    const tree = await confirmed(1000)
    await pressBtn(tree, 'Redeem')
    expect(texts(tree)).toContain(i18n.t('redeem.failed'))

    await ReactTestRenderer.act(async () => changeLink(tree)!.props.onPress())
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(AmountSheet).props.onConfirm(2000)
    })
    await settle()
    expect(texts(tree)).not.toContain(i18n.t('redeem.failed'))
  })

  it('cannot change the amount while the voucher is being pulled', async () => {
    jest.mocked(sparkConfirmLnurlWithdraw).mockReturnValue(new Promise(() => undefined))
    const tree = await confirmed(1000)
    await pressBtn(tree, 'Redeem')
    const link = changeLink(tree)!
    expect(link.props.state).toEqual({ disabled: true })
    await ReactTestRenderer.act(async () => link.props.onPress())
    expect(tree.root.findByType(AmountSheet).props.visible).toBe(false)
  })

  // Touch's own disabled state dims everything inside it, and the figure being redeemed is inside.
  it('dims only the change link while the voucher is being pulled, not the figure', async () => {
    jest.mocked(sparkConfirmLnurlWithdraw).mockReturnValue(new Promise(() => undefined))
    const tree = await confirmed(1000)
    await pressBtn(tree, 'Redeem')
    const link = changeLink(tree)!
    expect(link.props.disabled).toBeFalsy()
    const dimmed = link
      .findAll(n => n.type === View && flat(n.props.style).opacity === alpha.disabled)
      .map(n => n.findAllByType(Text).map(x => x.props.children))
    expect(dimmed).toEqual([[i18n.t('redeem.changeAmount')]])
  })

  it('reads the currency line in the change link\'s label when a rate is known', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 100_000 })
    const tree = await confirmed(1000)
    const label = changeLink(tree)!.props.label as string
    expect(label).toContain('≈ ')
    expect(label.indexOf('≈ ')).toBeLessThan(label.indexOf(i18n.t('redeem.changeAmount')))
  })

  it('offers no change on a fixed-value voucher, whose amount is not a choice', async () => {
    jest.mocked(sparkParseLnurlWithdraw).mockResolvedValue({
      handle: 'wd1',
      minSat: 5000,
      maxSat: 5000,
      description: 'Fixed voucher',
    })
    const tree = await confirmed(5000)
    expect(changeLink(tree)).toBeUndefined()
    expect(texts(tree)).not.toContain(i18n.t('redeem.changeAmount'))
  })
})


// spark.ts holds a voucher of a wallet whose exit is alive or unread, so a voucher scanned there opens
// on the line that says why, from any screen that opened it.
test.each([
  ['exit', 'emergencyExit.receiveHeld'],
  ['unread', 'emergencyExit.receiveHeldUnread'],
] as const)('a voucher on a wallet held by an exit (%s) says so and asks for no amount', async (hold, key) => {
  jest.mocked(sparkParseLnurlWithdraw).mockRejectedValueOnce(new ReceiveHeldByExit(hold))
  const tree = await render()
  expect(texts(tree)).toContain(i18n.t(key))
  expect(tree.root.findAllByType(AmountSheet).every(sheet => !sheet.props.visible)).toBe(true)
  expect(sparkConfirmLnurlWithdraw).not.toHaveBeenCalled()
})

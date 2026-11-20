import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Text } from 'react-native'
import i18n from '../src/i18n'
import { INCOMING_OUTCOME_LIMIT_MS, ReceivedOverlayHost } from '../src/components/ReceivedOverlayHost'
import { IncomingBanner } from '../src/components/IncomingBanner'
import {
  sparkGetFiatRates,
  sparkGetPayment,
  sparkListFiatCurrencies,
  sparkSubscribeToReceives,
  type ReceiveUpdate,
} from '../src/wallet/spark'
import { saveDisplayCurrency } from '../src/wallet/settings'
import RNFS from 'react-native-fs'
import { getCurrencies } from 'react-native-localize'
import { setLocalCurrency } from '../src/wallet/fiat'
import { PRICE_MAX_AGE_MS } from '../src/wallet/priceLine'
import { USDB } from '../src/wallet/tokens'

jest.mock('react-native-localize', () => ({
  ...jest.requireActual('react-native-localize/mock'),
  // Made settable so a test can place the device outside the US. src/i18n reads it once when it
  // loads, before any beforeEach runs, as the app does at boot.
  getCurrencies: jest.fn(() => ['USD', 'EUR']),
}))
// What src/i18n read at boot is the mock's first answer, which is what a test puts back.
const BOOT_DEVICE_CURRENCIES: string[] = jest.mocked(getCurrencies).mock.results[0].value

// The reanimated overlay is stubbed as a Text echo so the props the host threads can be asserted.
const mockOverlay: { onDone?: () => void } = {}
jest.mock('../src/components/ReceivedOverlay', () => {
  const react = require('react')
  const rn = require('react-native')
  return {
    ReceivedOverlay: ({
      amount,
      label,
      fiat,
      beneath,
      zap,
      onDone,
    }: {
      amount: { value: number; unit: string; format: (n: number) => string }
      label?: string
      fiat?: string
      beneath?: string
      zap?: { comment?: string }
      onDone: () => void
    }) => {
      mockOverlay.onDone = onDone
      return react.createElement(
        rn.Text,
        null,
        // The count-up's final frame is the formatted value, so that is printed too.
        `overlay ${amount.value} ${amount.unit} ${fiat ?? ''} ${zap ? `zap:${zap.comment ?? ''}` : ''} shown:${amount.format(amount.value)} beneath:${beneath ?? ''} label:${label ?? ''}`,
      )
    },
  }
})

let mockDollarMode = false
jest.mock('../src/wallet/dollarMode', () => ({
  ...jest.requireActual('../src/wallet/dollarMode'),
  useDollarMode: () => mockDollarMode,
}))

// onSparkConnected is captured rather than auto-fired so each test controls when the SDK connects.
const mockConnect: { cbs: Array<() => void> } = { cbs: [] }
jest.mock('../src/wallet/spark', () => ({
  onSparkConnected: (cb: () => void) => {
    mockConnect.cbs.push(cb)
    return () => {
      mockConnect.cbs = mockConnect.cbs.filter(c => c !== cb)
    }
  },
  sparkSubscribeToReceives: jest.fn().mockResolvedValue(() => undefined),
  sparkGetFiatRates: jest.fn().mockResolvedValue({ USD: 500000 }),
  sparkGetPayment: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

function fireConnect(): void {
  mockConnect.cbs.forEach(cb => cb())
}

beforeEach(() => {
  mockConnect.cbs = []
  jest.mocked(getCurrencies).mockReturnValue(BOOT_DEVICE_CURRENCIES)
  jest
    .mocked(sparkSubscribeToReceives)
    .mockReset()
    .mockResolvedValue(() => undefined)
})

function joined(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(node =>
      Array.isArray(node.props.children) ? node.props.children : [node.props.children],
    )
    .join(' ')
}

async function mountAndConnect(
  onDismiss?: () => void,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ReceivedOverlayHost onDismiss={onDismiss} />)
  })
  await ReactTestRenderer.act(async () => {
    fireConnect()
  })
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
  return tree
}

test('does not attach the receive listener until the SDK connects, then attaches', async () => {
  // An eager subscribe at mount would run requireSdk() before connect, throw, and be swallowed.
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<ReceivedOverlayHost />)
  })
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
  expect(sparkSubscribeToReceives).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    fireConnect()
  })
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
  expect(sparkSubscribeToReceives).toHaveBeenCalled()
})

test('re-attaches the listener on reconnect, dropping the previous one', async () => {
  // A network/wallet switch swaps the SDK instance, so the old listener is dead and must be replaced.
  const unsub1 = jest.fn()
  const unsub2 = jest.fn()
  jest
    .mocked(sparkSubscribeToReceives)
    .mockReset()
    .mockResolvedValueOnce(unsub1)
    .mockResolvedValueOnce(unsub2)

  await mountAndConnect()
  expect(sparkSubscribeToReceives).toHaveBeenCalledTimes(1)

  await ReactTestRenderer.act(async () => {
    fireConnect()
  })
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
  expect(unsub1).toHaveBeenCalledTimes(1)
  expect(sparkSubscribeToReceives).toHaveBeenCalledTimes(2)
})

test('subscribes on connect and shows the overlay with the received amount and fiat', async () => {
  const tree = await mountAndConnect()
  expect(joined(tree)).not.toContain('overlay')
  expect(sparkSubscribeToReceives).toHaveBeenCalled()

  const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls[0][0]

  // The test locale is en-US, so the still-settling pill reads "Incoming".
  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'incoming', sat: 50000 })
  })
  expect(joined(tree)).toContain('Incoming')
  expect(joined(tree)).not.toContain('overlay')

  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'received', sat: 50000 })
  })
  const text = joined(tree)
  expect(text).toContain('overlay 50000')
  // 50k sats at US$500k/BTC. The echo puts the fiat line between spaces, so a glyph in front of the $
  // (R$, A$, US$) cannot match.
  expect(text).toContain(' $250.00 ')
  expect(text).not.toContain('Incoming')
})

// A bare $ is the reader's own dollar, so the fiat line carries it only on a device whose own
// currency is USD. The overlay echo prints the line between spaces.
test('the fiat line is $ on a US device and US$ on an Australian one', async () => {
  async function fiatLine(deviceCurrencies: string[]): Promise<string> {
    setLocalCurrency(deviceCurrencies)
    const tree = await mountAndConnect()
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'received', sat: 50000 })
    })
    return joined(tree)
  }
  try {
    expect(await fiatLine(['USD'])).toContain(' $250.00 ')
    const away = await fiatLine(['AUD'])
    expect(away).toContain(' US$250.00 ')
    expect(away).not.toContain(' $250.00 ')
  } finally {
    setLocalCurrency(BOOT_DEVICE_CURRENCIES)
  }
})

test('threads a received zap comment down to the celebration overlay', async () => {
  const tree = await mountAndConnect()
  const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]

  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'received', sat: 50000, zap: { comment: 'gm from nostr' } })
  })
  expect(joined(tree)).toContain('zap:gm from nostr')

  // A plain receive must not carry the previous zap into the next overlay.
  await ReactTestRenderer.act(async () => {
    mockOverlay.onDone?.()
  })
  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'received', sat: 50000 })
  })
  expect(joined(tree)).not.toContain('zap:')
})

test('calls onDismiss (to leave the Receive screen) once the overlay closes', async () => {
  const onDismiss = jest.fn()
  const tree = await mountAndConnect(onDismiss)

  const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'received', sat: 50000 })
  })
  expect(joined(tree)).toContain('overlay 50000')

  await ReactTestRenderer.act(async () => {
    mockOverlay.onDone?.()
  })
  expect(onDismiss).toHaveBeenCalledTimes(1)
  expect(joined(tree)).not.toContain('overlay')
})

// A token's raw amount is its base units: without the asset, 10 USDB reads as 10,000,000 sats, and
// the fiat line prices those "sats" at US$ 50,000.
test('a token receive is shown in its own unit, with no sats fiat line', async () => {
  const tree = await mountAndConnect()
  const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
  const asset = { assetId: USDB.identifier, ticker: 'USDB', amount: '10' }

  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'incoming', sat: 10_000_000, asset })
  })
  // The unit is a nested Text, which joined() flattens apart from the figure.
  expect(joined(tree)).toMatch(/Incoming 10 .*USDB/)
  expect(joined(tree)).not.toContain('10 000 000')

  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'received', sat: 10_000_000, asset })
  })
  const text = joined(tree)
  expect(text).toContain('overlay 10 USDB')
  expect(text).not.toMatch(/(?<!R)\$\d/)
})

// Rounding to cents would land a sub-cent receive on "0 USDB", a figure the payment never had.
test('a token receive lands on its exact amount, however many places it carries', async () => {
  const tree = await mountAndConnect()
  const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
  const asset = { assetId: USDB.identifier, ticker: 'USDB', amount: '0.004321' }

  await ReactTestRenderer.act(async () => {
    onUpdate({ id: 'p', stage: 'received', sat: 4321, asset })
  })
  expect(joined(tree)).toContain('shown:0.004321')
})

// The rate is read once per connection, which can be hours old when a payment lands.
describe('the age of the rate', () => {
  let now = 0
  let clock: jest.SpyInstance<number, []>
  const later = (resolve: (rates: Record<string, number>) => void) => resolve

  beforeEach(() => {
    now = 1_000_000
    clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    jest.mocked(sparkGetFiatRates).mockClear()
  })

  afterEach(() => {
    clock.mockRestore()
    mockDollarMode = false
    jest.mocked(sparkGetFiatRates).mockReset().mockResolvedValue({ USD: 500000 })
  })

  async function receivedAfter(ageMs: number): Promise<{
    tree: ReactTestRenderer.ReactTestRenderer
    answer: (rates: Record<string, number>) => void
    fail: () => void
  }> {
    const tree = await mountAndConnect()
    now += ageMs
    let answer!: (rates: Record<string, number>) => void
    let fail!: () => void
    jest.mocked(sparkGetFiatRates).mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          answer = later(resolve)
          fail = () => reject(new Error('offline'))
        }),
    )
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'received', sat: 50000 })
    })
    return { tree, answer: rates => answer(rates), fail: () => fail() }
  }

  test('just under the age the rate of the connection prices it, with no second read', async () => {
    const { tree } = await receivedAfter(PRICE_MAX_AGE_MS - 1)

    expect(joined(tree)).toContain(' $250.00 ')
    expect(sparkGetFiatRates).toHaveBeenCalledTimes(1)
  })

  test('at the age it shows the sats with no fiat line, and the line comes from a new read', async () => {
    const { tree, answer } = await receivedAfter(PRICE_MAX_AGE_MS)

    expect(joined(tree)).toContain('overlay 50000')
    expect(joined(tree)).not.toContain('$250.00')
    expect(sparkGetFiatRates).toHaveBeenCalledTimes(2)

    await ReactTestRenderer.act(async () => {
      answer({ USD: 600000 })
    })
    expect(joined(tree)).toContain(' $300.00 ')
  })

  test('a new read that fails leaves no fiat line, never the old figure', async () => {
    const { tree, fail } = await receivedAfter(PRICE_MAX_AGE_MS * 10)
    await ReactTestRenderer.act(async () => {
      fail()
    })

    expect(joined(tree)).toContain('overlay 50000')
    expect(joined(tree)).not.toContain('$')
  })

  test('an answer after the overlay closed draws nothing', async () => {
    const { tree, answer } = await receivedAfter(PRICE_MAX_AGE_MS)
    await ReactTestRenderer.act(async () => {
      mockOverlay.onDone?.()
    })
    await ReactTestRenderer.act(async () => {
      answer({ USD: 600000 })
    })

    expect(joined(tree)).not.toContain('overlay')
  })

  test('on a dollar wallet an old rate leads with no dollars, only the sats', async () => {
    mockDollarMode = true
    const { tree } = await receivedAfter(PRICE_MAX_AGE_MS)

    expect(joined(tree)).toContain('shown:50\u00A0000')
    expect(joined(tree)).not.toContain('≈ $250.00')
  })

  test('the pill on a dollar wallet leads with no dollars once the rate is old', async () => {
    mockDollarMode = true
    const tree = await mountAndConnect()
    now += PRICE_MAX_AGE_MS
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'incoming', sat: 50000 })
    })

    expect(tree.root.findByType(IncomingBanner).props.dollars).toBeUndefined()
  })
})

describe('on a dollar wallet', () => {
  const USD_RATE = 100_000
  const received = async (sat: number, asset?: ReceiveUpdate['asset']): Promise<string> => {
    const tree = await mountAndConnect()
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'received', sat, ...(asset ? { asset } : {}) })
    })
    return joined(tree)
  }

  beforeEach(() => {
    mockDollarMode = true
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: USD_RATE })
  })

  afterEach(() => {
    mockDollarMode = false
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 500000 })
  })

  test('bitcoin arrives as approximate dollars with the sats beneath, and no word of a conversion', async () => {
    const shown = await received(12_300)

    expect(shown).toContain('shown:≈ $12.30')
    expect(shown).toContain('beneath:12\u00A0300 sats')
    expect(shown).not.toMatch(/USDB|convert/i)
  })

  test('with no dollar rate it is sats, as ever', async () => {
    jest.mocked(sparkGetFiatRates).mockResolvedValue({})

    const shown = await received(12_300)

    expect(shown).toContain('shown:12\u00A0300')
    expect(shown).toMatch(/beneath: /)
  })

  test('with the mode off it is sats, as ever', async () => {
    mockDollarMode = false

    const shown = await received(12_300)

    expect(shown).toContain('shown:12\u00A0300')
    expect(shown).not.toContain('≈ $12.30')
  })

  test('a token arrives exact, in its own unit, with no ≈', async () => {
    const shown = await received(10_000_000, { assetId: USDB.identifier, ticker: 'USDB', amount: '10.00' })

    expect(shown).toContain('overlay 10 USDB')
    expect(shown).toMatch(/beneath: /)
    expect(shown).not.toContain('≈')
  })

  test('under a cent the sats lead, since dollars would read as nothing', async () => {
    const shown = await received(5)

    expect(shown).toContain('shown:5 ')
    expect(shown).not.toContain('$0.00')
  })

  test('the pill leads with the same dollars, and says what it shows', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    const tree = await mountAndConnect()
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'incoming', sat: 12_300 })
    })

    expect(tree.root.findByType(IncomingBanner).props.dollars).toBe('≈ $12.30')
    expect(announce).toHaveBeenLastCalledWith(expect.stringContaining('≈ $12.30, 12\u00A0300 sats'))
    announce.mockRestore()
  })
})

// The EUR case configures the module-level fiat registry and nothing earlier in the file does, so this
// block stays last and the case starts from the bare-code state of a fresh process.
describe('display currency', () => {
  // A device in Brazil, so the region default (BRL) and the saved choice differ. Rates put 2,000 sats
  // at R$ 11.00 and € 1.80. Only the coins asked for are answered, as sparkGetFiatRates does.
  const RATES: Record<string, number> = { BRL: 550_000, EUR: 90_000 }
  beforeEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    jest.mocked(getCurrencies).mockReturnValue(['BRL'])
    jest
      .mocked(sparkGetFiatRates)
      .mockImplementation(async coins => Object.fromEntries(coins.filter(c => c in RATES).map(c => [c, RATES[c]])))
  })
  afterEach(() => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    jest.mocked(sparkGetFiatRates).mockResolvedValue({ USD: 500000 })
  })

  async function shownOnReceive(): Promise<string> {
    const tree = await mountAndConnect()
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'received', sat: 2000 })
    })
    return joined(tree)
  }

  // The overlay is global and can draw before any screen has loaded the SDK's currency list, so the
  // symbol is there only when the host configures the formatter itself.
  test('a saved currency beyond BRL and USD shows its symbol, not its bare code', async () => {
    jest
      .mocked(sparkListFiatCurrencies)
      .mockResolvedValue([{ id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }])
    await saveDisplayCurrency('EUR')

    const text = await shownOnReceive()

    expect(text).toContain('€1.80')
    expect(text).not.toContain('EUR')
  })

  test('with nothing saved the fiat line is in the device region currency', async () => {
    const text = await shownOnReceive()

    expect(text).toContain('R$11.00')
  })

  describe('after a change of currency', () => {
    const EUR = { id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 }
    let clock: jest.SpyInstance<number, []>
    // One instant throughout, so rates read before the change are as young as any read after it.
    beforeEach(() => {
      clock = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
      jest.mocked(sparkListFiatCurrencies).mockResolvedValue([EUR])
    })
    afterEach(() => clock.mockRestore())

    function heldRead(): (rates: Record<string, number>) => void {
      let answer!: (rates: Record<string, number>) => void
      jest.mocked(sparkGetFiatRates).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
      return rates => answer(rates)
    }

    async function received(tree: ReactTestRenderer.ReactTestRenderer): Promise<string> {
      const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
      await ReactTestRenderer.act(async () => {
        onUpdate({ id: 'p', stage: 'received', sat: 2000 })
      })
      return joined(tree)
    }

    test('rates held in the old currency price nothing while the new read is out', async () => {
      const tree = await mountAndConnect()
      expect(sparkGetFiatRates).toHaveBeenLastCalledWith(['BRL', 'USD'])
      const answerEur = heldRead()

      await ReactTestRenderer.act(async () => {
        await saveDisplayCurrency('EUR')
      })
      expect(await received(tree)).not.toContain('R$')

      await ReactTestRenderer.act(async () => {
        answerEur({ EUR: RATES.EUR })
      })
      expect(joined(tree)).toContain('€1.80')
    })

    test('a read begun in the old currency that answers late is dropped', async () => {
      const answerBrl = heldRead()
      const tree = await mountAndConnect()

      await ReactTestRenderer.act(async () => {
        await saveDisplayCurrency('EUR')
      })
      await ReactTestRenderer.act(async () => {
        answerBrl({ BRL: RATES.BRL })
      })

      const text = await received(tree)
      expect(text).toContain('€1.80')
      expect(text).not.toContain('R$')
    })
  })

  // With nothing saved and a region that names no currency, the language picks it, dollars in en-US
  // and reais in pt-BR, so a change of language can change the currency a figure is in.
  describe('after a change of language', () => {
    const BY_LANGUAGE: Record<string, number> = { USD: 500_000, BRL: 550_000 }
    let clock: jest.SpyInstance<number, []>
    beforeEach(async () => {
      clock = jest.spyOn(Date, 'now').mockReturnValue(1_000_000)
      jest.mocked(getCurrencies).mockReturnValue([])
      jest
        .mocked(sparkGetFiatRates)
        .mockImplementation(async coins =>
          Object.fromEntries(coins.filter(c => c in BY_LANGUAGE).map(c => [c, BY_LANGUAGE[c]])),
        )
      await i18n.changeLanguage('en-US')
    })
    afterEach(async () => {
      clock.mockRestore()
      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('en-US')
      })
    })

    test('rates held in the old language\'s currency price nothing while the new read is out', async () => {
      const tree = await mountAndConnect()
      expect(sparkGetFiatRates).toHaveBeenLastCalledWith(['USD'])
      let answerBrl!: (rates: Record<string, number>) => void
      jest.mocked(sparkGetFiatRates).mockImplementationOnce(() => new Promise(resolve => (answerBrl = resolve)))

      await ReactTestRenderer.act(async () => {
        await i18n.changeLanguage('pt-BR')
      })
      const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
      await ReactTestRenderer.act(async () => {
        onUpdate({ id: 'p', stage: 'received', sat: 2000 })
      })
      expect(joined(tree)).not.toContain('$')
      expect(sparkGetFiatRates).toHaveBeenLastCalledWith(['BRL', 'USD'])

      await ReactTestRenderer.act(async () => {
        answerBrl({ BRL: BY_LANGUAGE.BRL })
      })
      expect(joined(tree)).toContain('R$')
    })
  })
})

describe('the arriving pill', () => {
  let emit: (update: ReceiveUpdate) => void
  const incoming: ReceiveUpdate = { id: 'p1', stage: 'incoming', sat: 2100 }

  const pillUp = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findByType(IncomingBanner).props.visible as boolean

  async function mountWithPill(): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(sparkSubscribeToReceives).mockImplementation(async cb => {
      emit = cb
      return () => undefined
    })
    const tree = await mountAndConnect()
    jest.useFakeTimers()
    await ReactTestRenderer.act(async () => emit(incoming))
    expect(pillUp(tree)).toBe(true)
    return tree
  }

  async function passLimit(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(INCOMING_OUTCOME_LIMIT_MS)
      await Promise.resolve()
    })
    await ReactTestRenderer.act(async () => {
      await jest.advanceTimersByTimeAsync(0)
    })
  }

  beforeEach(() => {
    jest.mocked(sparkGetPayment).mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  test('a failed receive of that payment takes it down, and asks nothing more', async () => {
    const tree = await mountWithPill()
    await ReactTestRenderer.act(async () => emit({ id: 'p1', stage: 'failed', sat: 2100 }))
    expect(pillUp(tree)).toBe(false)

    await passLimit()
    expect(sparkGetPayment).not.toHaveBeenCalled()
  })

  test("another payment's failure leaves it up", async () => {
    const tree = await mountWithPill()
    await ReactTestRenderer.act(async () => emit({ id: 'other', stage: 'failed', sat: 1 }))
    expect(pillUp(tree)).toBe(true)
  })

  test('with no outcome by the limit it asks once, and a settled payment is announced', async () => {
    jest.mocked(sparkGetPayment).mockResolvedValue({
      id: 'p1',
      status: 'complete',
      amountSat: 2100,
      asset: null,
    } as never)
    const tree = await mountWithPill()
    await passLimit()

    expect(sparkGetPayment).toHaveBeenCalledTimes(1)
    expect(sparkGetPayment).toHaveBeenCalledWith('p1')
    expect(pillUp(tree)).toBe(false)
    expect(joined(tree)).toContain('overlay 2100')
  })

  test.each([
    ['still pending', () => Promise.resolve({ id: 'p1', status: 'pending', amountSat: 2100, asset: null })],
    ['failed', () => Promise.resolve({ id: 'p1', status: 'failed', amountSat: 2100, asset: null })],
    ['a read that fails', () => Promise.reject(new Error('offline'))],
  ])('%s takes the pill down and announces nothing', async (_name, answer) => {
    jest.mocked(sparkGetPayment).mockImplementation(answer as never)
    const tree = await mountWithPill()
    await passLimit()

    expect(pillUp(tree)).toBe(false)
    expect(joined(tree)).not.toContain('overlay')
  })

  test('the event coming after the limit announced it brings no second overlay', async () => {
    jest.mocked(sparkGetPayment).mockResolvedValue({
      id: 'p1',
      status: 'complete',
      amountSat: 2100,
      asset: null,
    } as never)
    const tree = await mountWithPill()
    await passLimit()
    expect(joined(tree)).toContain('overlay 2100')
    await ReactTestRenderer.act(async () => {
      mockOverlay.onDone?.()
    })

    await ReactTestRenderer.act(async () => emit({ id: 'p1', stage: 'received', sat: 2100 }))

    expect(joined(tree)).not.toContain('overlay')
  })

  test('another payment after it is announced as ever', async () => {
    jest.mocked(sparkGetPayment).mockResolvedValue({
      id: 'p1',
      status: 'complete',
      amountSat: 2100,
      asset: null,
    } as never)
    const tree = await mountWithPill()
    await passLimit()
    await ReactTestRenderer.act(async () => {
      mockOverlay.onDone?.()
    })

    await ReactTestRenderer.act(async () => emit({ id: 'p2', stage: 'received', sat: 700 }))

    expect(joined(tree)).toContain('overlay 700')
  })

  test('the announcement in time cancels the limit', async () => {
    const tree = await mountWithPill()
    await ReactTestRenderer.act(async () => emit({ id: 'p1', stage: 'received', sat: 2100 }))
    expect(pillUp(tree)).toBe(false)

    await passLimit()
    expect(sparkGetPayment).not.toHaveBeenCalled()
  })
})

// A receive names the rail its record gives, and a token by its identifier alone: anyone can issue a
// token that calls itself USDB, or sats.
describe('what the arrival says', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en-US')
  })

  const arrive = async (update: Omit<ReceiveUpdate, 'id' | 'stage'>): Promise<ReactTestRenderer.ReactTestRenderer> => {
    const tree = await mountAndConnect()
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'incoming', ...update })
    })
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'received', ...update })
    })
    return tree
  }

  test('a token received over Spark is titled by that rail and counted in its own unit', async () => {
    const tree = await arrive({
      sat: 10_000_000,
      rail: 'spark',
      asset: { assetId: USDB.identifier, ticker: 'USDB', amount: '10' },
    })

    const text = joined(tree)
    expect(text).toContain('overlay 10 USDB')
    expect(text).toContain('label:Received via the Spark network')
    expect(text).not.toContain('sats')
  })

  test('a Lightning receive says Lightning, on the pill and on the overlay', async () => {
    const tree = await mountAndConnect()
    const onUpdate = jest.mocked(sparkSubscribeToReceives).mock.calls.at(-1)![0]
    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'incoming', sat: 21_000, rail: 'lightning' })
    })
    expect(joined(tree)).toContain('Incoming via Lightning')

    await ReactTestRenderer.act(async () => {
      onUpdate({ id: 'p', stage: 'received', sat: 21_000, rail: 'lightning' })
    })
    expect(joined(tree)).toContain('label:Received via Lightning')
  })

  test('an on-chain receive says the Bitcoin network', async () => {
    const tree = await arrive({ sat: 50_000, rail: 'bitcoin' })

    expect(joined(tree)).toContain('label:Received via the Bitcoin network')
  })

  test('a token under another identifier is never named by what it calls itself', async () => {
    const tree = await arrive({
      sat: 10_000_000,
      rail: 'spark',
      asset: { assetId: 'btkn1somebodyelse', ticker: 'USDB', amount: '10' },
    })

    const text = joined(tree)
    expect(text).not.toContain('USDB')
    expect(text).toContain('shown:10')
    expect(text).toContain(`beneath:${i18n.t('notice.unknownToken')}`)
    expect(text).not.toContain('sats')
  })

  test('a zap keeps its own title', async () => {
    const tree = await arrive({ sat: 21, rail: 'lightning', zap: { comment: 'gm' } })

    expect(joined(tree)).toMatch(/label:$/)
  })

  test('a record that names no rail keeps the words it had', async () => {
    const tree = await arrive({ sat: 21 })

    expect(joined(tree)).toContain(`label:${i18n.t('receive.gotIt')}`)
  })
})

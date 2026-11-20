import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Dimensions, StyleSheet, Text } from 'react-native'
import i18n from '../src/i18n'
import { PriceStrip, priceStripHeight } from '../src/components/PriceStrip'
import { PRICE_MAX_AGE_MS, PRICE_READ_EVERY_MS, priceIsOld, rateFor } from '../src/wallet/priceLine'
import { Skeleton } from '../src/components/Skeleton'
import { formatFiat } from '../src/wallet/fiat'
import { fetchBtcPriceSeries, type PricePoint } from '../src/wallet/price'
import { useBtcDayChange } from '../src/hooks/useBtcDayChange'
import { colors, font, space } from '../src/theme'
import { Txt, roles, type Role } from '../src/components/Txt'
import { Figure } from '../src/components/Amount'
import { FigureRow } from '../src/components/FigureRow'
import { Row } from '../src/components/Row'
import { Touch } from '../src/components/Touch'
import { figuresHeldOut, hostParent } from './support/figureFit'
import { announceDisplayCurrencyChanged } from '../src/wallet/displayCurrencyNotice'
import { resolveDisplayCurrency } from '../src/wallet/fiatDisplay'
import { sparkGetFiatRates, sparkConnectedWalletId, SYNC_WAIT_MS } from '../src/wallet/spark'

let mockConnected: (() => void) | null = null
jest.mock('../src/wallet/spark', () => ({
  SYNC_WAIT_MS: 12_000,
  sparkGetFiatRates: jest.fn(),
  sparkConnectedWalletId: jest.fn(() => 'w1'),
  onSparkConnected: jest.fn((cb: () => void) => {
    mockConnected = cb
    return () => {
      mockConnected = null
    }
  }),
}))
jest.mock('../src/wallet/fiatDisplay', () => ({ resolveDisplayCurrency: jest.fn(async () => 'BRL') }))
let mockWalletChanged: (() => void) | null = null
jest.mock('../src/wallet/wallet', () => ({
  onActiveWalletChanged: jest.fn((cb: () => void) => {
    mockWalletChanged = cb
    return () => {
      mockWalletChanged = null
    }
  }),
}))

// jest.setup.js keeps every other suite off the network with a stand-in for this hook.
jest.unmock('../src/hooks/useBtcDayChange')
jest.mock('../src/wallet/price', () => ({
  ...jest.requireActual('../src/wallet/price'),
  fetchBtcPriceSeries: jest.fn(),
}))

const rates = jest.mocked(sparkGetFiatRates)
const series = jest.mocked(fetchBtcPriceSeries)
let mockFocused = true
let mockStale = false
const connected = jest.mocked(sparkConnectedWalletId)
const currency = jest.mocked(resolveDisplayCurrency)

function hanging<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (cause: Error) => void } {
  let resolve!: (value: T) => void
  let reject!: (cause: Error) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let tree: ReactTestRenderer.ReactTestRenderer | null = null
let opened: jest.Mock
let appListener: ((state: string) => void) | null = null
let appRemove: jest.Mock

async function flush(ms = 0): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<PriceStrip onOpen={opened} focused={mockFocused} beat={0} stale={mockStale} />)
  })
  return tree as ReactTestRenderer.ReactTestRenderer
}

const shownTexts = (root: ReactTestRenderer.ReactTestRenderer): string[] =>
  root.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter((child): child is string => typeof child === 'string')

const fiat = (value: number, code = 'BRL') => formatFiat(value, code)
// The price as the band draws it, the rate of one whole bitcoin.
const price = (value: number, code = 'BRL') => i18n.t('home.priceOfOneBitcoin', { price: fiat(value, code) })
const period = () => i18n.t('home.changePeriod')

const targets = (root: ReactTestRenderer.ReactTestRenderer) =>
  root.root.findAll(
    node => typeof node.props.onPress === 'function' && typeof node.props.accessibilityRole === 'string',
  )

async function toApp(state: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    appListener?.(state)
    await jest.advanceTimersByTimeAsync(0)
  })
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.setSystemTime(new Date('2026-11-04T12:00:00Z'))
  opened = jest.fn()
  appRemove = jest.fn()
  mockFocused = true
  mockStale = false
  rates.mockReset()
  rates.mockResolvedValue({ BRL: 600_000 })
  series.mockReset()
  series.mockResolvedValue(null)
  connected.mockReturnValue('w1')
  currency.mockClear()
  currency.mockResolvedValue('BRL')
  ;(AppState as { currentState: string }).currentState = 'active'
  jest.mocked(AppState.addEventListener).mockImplementation(((type: string, cb: (state: string) => void) => {
    if (type === 'change') {
      appListener = cb
    }
    return { remove: appRemove }
  }) as never)
})

afterEach(() => {
  ReactTestRenderer.act(() => tree?.unmount())
  tree = null
  appListener = null
  jest.useRealTimers()
})

test('shows Bitcoin and the price in the display currency, formatted as the app formats it', async () => {
  const root = await mount()
  await flush()

  expect(rates).toHaveBeenCalledWith(['BRL'])
  expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000)])
  expect(price(600_000)).toBe(`1 BTC = ${fiat(600_000)}`)
})

const NOW = new Date('2026-11-04T12:00:00Z').getTime()
const day = (from: number, to: number): PricePoint[] => [
  { t: NOW - 24 * 3_600_000, v: from },
  { t: NOW - 60_000, v: to },
]

describe('the change over 24 hours', () => {
  const painted = (root: ReactTestRenderer.ReactTestRenderer, text: string) =>
    root.root.findAllByType(Text).find(node => node.props.children === text)
  const colorOf = (root: ReactTestRenderer.ReactTestRenderer, text: string) =>
    Object.assign({}, ...[painted(root, text)?.props.style].flat(Infinity).filter(Boolean)).color

  test('a rise shows its sign in the default tone, beside the price, over the 24 hours it was measured on', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()

    expect(series).toHaveBeenCalledWith('1D', 600_000)
    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), '+2.00%', period()])
    expect(period()).toBe('24h')
    expect(colorOf(root, '+2.00%')).toBe(colors.text)
    expect(colorOf(root, period())).toBe(colors.textSecondary)
  })

  test('a fall keeps the minus the app draws beside a figure, in the same tone as a rise', async () => {
    series.mockResolvedValue(day(100, 98))
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toContain('\u22122.00%')
    expect(colorOf(root, '\u22122.00%')).toBe(colors.text)
  })

  // A fall of 0.004% draws as 0.00, which states no change, so it carries the plus.
  test('a fall too small to draw reads as no change, never as a minus zero', async () => {
    series.mockResolvedValue(day(100_000, 99_996))
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toContain('+0.00%')
    expect(shownTexts(root)).not.toContain('−0.00%')
    expect(colorOf(root, '+0.00%')).toBe(colors.text)
  })

  // A fall that rounds up to the last digit drawn is still a fall.
  test('a fall that draws as 0.01 keeps its minus', async () => {
    series.mockResolvedValue(day(100_000, 99_990))
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toContain('−0.01%')
    expect(colorOf(root, '−0.01%')).toBe(colors.text)
  })

  test('with no series the price stands alone, and no figure is guessed', async () => {
    series.mockResolvedValue(null)
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000)])
    expect(targets(root)[0].props.accessibilityLabel).toBe(i18n.t('home.bitcoinPrice', { price: fiat(600_000) }))
    // Nothing on the right, and the band keeps the height it has with a change.
    const { fontScale } = Dimensions.get('window')
    const band = StyleSheet.flatten((root.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props.style)
    expect(band.height).toBe(priceStripHeight(fontScale, true))
  })

  test('a series that failed to read leaves the price alone too', async () => {
    series.mockRejectedValue(new Error('no file'))
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000)])
  })

  test('a series that stopped hours ago states no change', async () => {
    series.mockResolvedValue([
      { t: NOW - 30 * 3_600_000, v: 100 },
      { t: NOW - 6 * 3_600_000, v: 130 },
    ])
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000)])
  })

  describe('stands only on a series read for the price beside it', () => {
    let seen: number | null
    function Change({ spot }: { spot: number | null }): null {
      seen = useBtcDayChange(spot)
      return null
    }
    async function at(spot: number | null): Promise<void> {
      await ReactTestRenderer.act(async () => {
        const element = <Change spot={spot} />
        if (tree === null) {
          tree = ReactTestRenderer.create(element)
        } else {
          tree.update(element)
        }
      })
      await flush()
    }

    test('a price that went and came back waits for its series', async () => {
      series.mockResolvedValue(day(100, 102))
      await at(600_000)
      expect(seen).toBeCloseTo(2)

      await at(null)
      expect(seen).toBeNull()

      const late = hanging<PricePoint[] | null>()
      series.mockReturnValue(late.promise)
      await at(610_000)
      expect(seen).toBeNull()

      late.resolve(day(100, 105))
      await flush()
      expect(seen).toBeCloseTo(5)
    })

    test('the same price coming back waits too', async () => {
      series.mockResolvedValue(day(100, 102))
      await at(600_000)
      await at(null)

      series.mockReturnValue(hanging<PricePoint[] | null>().promise)
      await at(600_000)

      expect(seen).toBeNull()
    })

    test('a price that moved keeps the change until its own answer lands', async () => {
      series.mockResolvedValue(day(100, 102))
      await at(600_000)

      const late = hanging<PricePoint[] | null>()
      series.mockReturnValue(late.promise)
      await at(601_000)
      expect(seen).toBeCloseTo(2)

      late.resolve(day(100, 105))
      await flush()
      expect(seen).toBeCloseTo(5)
    })

    test('a change held past the age of the series is gone, with the next read still out', async () => {
      series.mockResolvedValue(day(100, 102))
      await at(600_000)

      series.mockReturnValue(hanging<PricePoint[] | null>().promise)
      const now = Date.now()
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60 * 1000)
      await at(601_000)
      clock.mockRestore()
      expect(seen).toBeNull()
    })
  })

  test('a screen reader hears the price and the change over 24 hours in one line', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()

    expect(targets(root)[0].props.accessibilityLabel).toBe(
      i18n.t('home.bitcoinPriceChange', { price: fiat(600_000), change: '+2.00%' }),
    )
    expect(targets(root)[0].props.accessibilityLabel).toBe(`Bitcoin price: ${fiat(600_000)}, +2.00% in 24 hours`)
  })

  test('no figure is held out of the row at any size', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()

    expect(figuresHeldOut(root.root)).toEqual([])
  })
})

test('reads at once, then every minute', async () => {
  await mount()
  await flush()
  expect(rates).toHaveBeenCalledTimes(1)

  await flush(PRICE_READ_EVERY_MS - 1)
  expect(rates).toHaveBeenCalledTimes(1)
  await flush(1)
  expect(rates).toHaveBeenCalledTimes(2)
})

test('a new read moves the figure', async () => {
  const root = await mount()
  await flush()
  rates.mockResolvedValue({ BRL: 610_000 })

  await flush(PRICE_READ_EVERY_MS)

  expect(shownTexts(root)).toContain(price(610_000))
  expect(shownTexts(root)).not.toContain(price(600_000))
})

test('a tap opens the Bitcoin asset screen', async () => {
  const root = await mount()
  await flush()

  ReactTestRenderer.act(() => targets(root)[0].props.onPress())

  expect(opened).toHaveBeenCalledTimes(1)
})

describe('nothing past three minutes, or after a failed read, reads as current', () => {
  const colourOf = (root: ReactTestRenderer.ReactTestRenderer, text: string) =>
    StyleSheet.flatten(root.root.findAllByType(Text).find(node => node.props.children === text)?.props.style)?.color
  // The price line is muted whether current or not, so a price that stopped being current is told by
  // the word across from the name, and a current one carries no such word.
  const notCurrent = () => i18n.t('home.priceNotCurrent')
  const reads = async (root: ReactTestRenderer.ReactTestRenderer, text: string) => {
    expect(shownTexts(root)).toContain(text)
    expect(shownTexts(root)).not.toContain(notCurrent())
  }
  const isMuted = async (root: ReactTestRenderer.ReactTestRenderer, text: string) => {
    expect(shownTexts(root)).toContain(text)
    expect(shownTexts(root)).toContain(notCurrent())
    expect(colourOf(root, notCurrent())).toBe(colors.textSecondary)
  }

  test('reads that never answer take it down the same', async () => {
    const root = await mount()
    await flush()
    rates.mockImplementation(() => new Promise(() => undefined))

    await flush(PRICE_MAX_AGE_MS)

    expect(shownTexts(root)).toEqual([])
  })

  test('a read that fails mutes the price at once, and the next good read brings it back', async () => {
    const root = await mount()
    await flush()
    rates.mockRejectedValue(new Error('offline'))

    await flush(PRICE_READ_EVERY_MS)
    await isMuted(root, price(600_000))

    rates.mockResolvedValue({ BRL: 600_000 })
    await flush(PRICE_READ_EVERY_MS)
    await reads(root, price(600_000))
  })

  test('the change goes with it and the strip keeps its height', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()
    const height = JSON.stringify(root.toJSON()).match(/"height":\d+/)?.[0]
    expect(shownTexts(root)).toContain(i18n.t('asset.delta', { value: '+2.00' }))
    rates.mockRejectedValue(new Error('offline'))

    await flush(PRICE_READ_EVERY_MS)

    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), notCurrent()])
    expect(JSON.stringify(root.toJSON()).match(/"height":\d+/)?.[0]).toBe(height)
  })

  test('a hero that says not updated mutes the strip with the reads still answering', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()

    mockStale = true
    await ReactTestRenderer.act(async () => {
      root.update(<PriceStrip onOpen={opened} focused={mockFocused} beat={0} stale={mockStale} />)
    })
    await flush()

    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), notCurrent()])
    await isMuted(root, price(600_000))
    expect(targets(root)[0].props.accessibilityLabel).toContain(i18n.t('home.notUpdated'))
  })

  test('a good read pushes the limit out', async () => {
    const root = await mount()
    await flush()

    await flush(PRICE_MAX_AGE_MS + PRICE_READ_EVERY_MS)

    expect(shownTexts(root)).toContain(price(600_000))
  })

  test('the age counts from when the read left, so a slow answer does not reset it', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()

    await flush(30_000)
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })
    await flush()
    expect(shownTexts(root)).toContain(price(600_000))

    await flush(PRICE_MAX_AGE_MS - 30_000)
    expect(shownTexts(root)).toEqual([])
  })

  test('an answer that took longer than the limit is not shown', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    const root = await mount()
    // Off the air, so no later read replaces this one.
    connected.mockReturnValue(null)

    await flush(PRICE_MAX_AGE_MS)
    // No timer runs here, so nothing else could take such a figure down before it paints.
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })

    expect(shownTexts(root)).toEqual([])
  })

  test('back from the background past the limit, the old figure is gone before any answer', async () => {
    const root = await mount()
    await flush()
    await toApp('background')
    jest.setSystemTime(Date.now() + PRICE_MAX_AGE_MS)
    rates.mockImplementation(() => new Promise(() => undefined))

    // With no timer advanced, since the figure must not stay up for a frame.
    ReactTestRenderer.act(() => appListener?.('active'))

    expect(shownTexts(root)).toEqual([])
    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('back inside the limit the figure stays, and the rest of its time still counts', async () => {
    const root = await mount()
    await flush()
    await toApp('background')
    jest.setSystemTime(Date.now() + 100_000)
    rates.mockRejectedValue(new Error('offline'))

    await toApp('active')
    expect(shownTexts(root)).toContain(price(600_000))

    await flush(PRICE_MAX_AGE_MS - 100_000)
    expect(shownTexts(root)).toEqual([])
  })

  test('the strip keeps its height with a figure and without one', async () => {
    const height = (root: ReactTestRenderer.ReactTestRenderer) =>
      root.toTree() && JSON.stringify(root.toJSON()).match(/"height":(\d+)/)?.[1]
    const root = await mount()
    const before = height(root)
    await flush()
    const withFigure = height(root)
    rates.mockRejectedValue(new Error('offline'))
    await flush(PRICE_MAX_AGE_MS)

    expect(shownTexts(root)).toEqual([])
    expect(height(root)).toBe(before)
    expect(withFigure).toBe(before)
  })
})

describe('a feed without the currency', () => {
  test('shows nothing', async () => {
    rates.mockResolvedValue({ USD: 110_000 })
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toEqual([])
  })

  test('takes a figure already up down', async () => {
    const root = await mount()
    await flush()
    rates.mockResolvedValue({ USD: 110_000 })

    await flush(PRICE_READ_EVERY_MS)

    expect(shownTexts(root)).toEqual([])
  })

  test('rateFor refuses what no price can be', () => {
    expect(rateFor({ BRL: 0 }, 'BRL')).toBeNull()
    expect(rateFor({ BRL: -1 }, 'BRL')).toBeNull()
    expect(rateFor({ BRL: Number.NaN }, 'BRL')).toBeNull()
    expect(rateFor({ BRL: Number.POSITIVE_INFINITY }, 'BRL')).toBeNull()
    expect(rateFor({}, 'BRL')).toBeNull()
    expect(rateFor({ BRL: 1 }, 'BRL')).toBe(1)
  })
})

test('priceIsOld is true from the limit itself', () => {
  expect(priceIsOld(0, PRICE_MAX_AGE_MS - 1)).toBe(false)
  expect(priceIsOld(0, PRICE_MAX_AGE_MS)).toBe(true)
})

describe('no timer in the background or after unmount', () => {
  test('no timer is left while the app is away, and no read goes out', async () => {
    await mount()
    await flush()
    expect(jest.getTimerCount()).toBeGreaterThan(0)

    await toApp('background')

    expect(jest.getTimerCount()).toBe(0)
    const reads = rates.mock.calls.length
    await flush(10 * PRICE_READ_EVERY_MS)
    expect(rates).toHaveBeenCalledTimes(reads)
  })

  test("'inactive' counts as away", async () => {
    await mount()
    await flush()

    await toApp('inactive')

    expect(jest.getTimerCount()).toBe(0)
  })

  test('coming back reads at once and starts the minute again', async () => {
    await mount()
    await flush()
    await toApp('background')
    const reads = rates.mock.calls.length

    await toApp('active')
    expect(rates).toHaveBeenCalledTimes(reads + 1)

    await flush(PRICE_READ_EVERY_MS)
    expect(rates).toHaveBeenCalledTimes(reads + 2)
  })

  test('a second active does not start a second minute', async () => {
    await mount()
    await flush()
    await toApp('active')
    await flush()
    const reads = rates.mock.calls.length

    await flush(PRICE_READ_EVERY_MS)

    expect(rates).toHaveBeenCalledTimes(reads + 1)
  })

  test('unmounting stops every timer and every listener', async () => {
    const root = await mount()
    await flush()

    ReactTestRenderer.act(() => root.unmount())
    tree = null

    expect(jest.getTimerCount()).toBe(0)
    expect(appRemove).toHaveBeenCalledTimes(1)
    expect(mockConnected).toBeNull()
    expect(mockWalletChanged).toBeNull()
  })

  test('an app woken in the background starts nothing until it comes to the front', async () => {
    ;(AppState as { currentState: string }).currentState = 'background'
    await mount()
    await flush()

    expect(jest.getTimerCount()).toBe(0)
    expect(rates).not.toHaveBeenCalled()

    await toApp('active')
    expect(rates).toHaveBeenCalledTimes(1)
  })

  test('a read landing while the app is away lands nothing', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    const root = await mount()

    await toApp('background')
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })
    await flush()

    expect(shownTexts(root)).toEqual([])
  })
})

describe('a failure is never said here', () => {
  test('a failed first read shows no text at all', async () => {
    rates.mockRejectedValue(new Error('rates down'))
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toEqual([])
    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('a failed currency lookup shows no text either', async () => {
    currency.mockRejectedValue(new Error('settings unreadable'))
    const root = await mount()
    await flush()

    expect(shownTexts(root)).toEqual([])
  })

  test('a failed read keeps the figure of the last good one, and says nothing of why', async () => {
    const root = await mount()
    await flush()
    rates.mockRejectedValue(new Error('rates down'))

    await flush(PRICE_READ_EVERY_MS)

    expect(shownTexts(root)).toContain(price(600_000))
  })
})

describe('a read that lands after a change is dropped', () => {
  test('after a currency change, and the new currency is read at once', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    const root = await mount()
    await flush()

    currency.mockResolvedValue('USD')
    rates.mockResolvedValue({ USD: 110_000 })
    await ReactTestRenderer.act(async () => {
      announceDisplayCurrencyChanged()
    })
    await flush()
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })
    await flush()

    expect(shownTexts(root)).toContain(price(110_000, 'USD'))
    expect(shownTexts(root)).not.toContain(price(600_000))
  })

  test('after a currency change with no connection left to read again through', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    const root = await mount()
    await flush()

    connected.mockReturnValue(null)
    await ReactTestRenderer.act(async () => {
      announceDisplayCurrencyChanged()
    })
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })
    await flush()

    expect(shownTexts(root)).toEqual([])
  })

  test('the old currency goes the moment the change is heard', async () => {
    const root = await mount()
    await flush()
    rates.mockImplementation(() => new Promise(() => undefined))

    await ReactTestRenderer.act(async () => {
      announceDisplayCurrencyChanged()
    })

    expect(shownTexts(root)).toEqual([])
    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('after a wallet switch', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    const root = await mount()
    await flush()

    ReactTestRenderer.act(() => mockWalletChanged?.())
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })
    await flush()

    expect(shownTexts(root)).toEqual([])
  })

  test('a read that a newer one replaced lands nothing', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    rates.mockResolvedValue({ BRL: 610_000 })
    const root = await mount()
    await flush(PRICE_READ_EVERY_MS)
    expect(shownTexts(root)).toContain(price(610_000))

    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 590_000 })
    })
    await flush()

    expect(shownTexts(root)).toContain(price(610_000))
    expect(shownTexts(root)).not.toContain(price(590_000))
  })
})

test('a connect reads at once, and without a connection nothing is read', async () => {
  connected.mockReturnValue(null)
  await mount()
  await flush()
  expect(rates).not.toHaveBeenCalled()

  connected.mockReturnValue('w1')
  await ReactTestRenderer.act(async () => mockConnected?.())

  expect(rates).toHaveBeenCalledTimes(1)
})

test('the line is one reader, with the words for the bitcoin price', async () => {
  const root = await mount()
  await flush()

  const target = targets(root)[0]
  expect(target.props.accessibilityLabel).toBe(i18n.t('home.bitcoinPrice', { price: fiat(600_000) }))
  expect(target.props.accessibilityRole).toBe('button')
  expect(i18n.t('home.bitcoinPrice')).not.toBe('home.bitcoinPrice')
})

test('with no figure there is nothing to tap and nothing to read', async () => {
  rates.mockRejectedValue(new Error('rates down'))
  const root = await mount()
  await flush()

  expect(targets(root)).toHaveLength(0)
})

describe('a skeleton only before the first answer', () => {
  test('in flight at first it waits on a skeleton', async () => {
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()
    await flush()

    expect(root.root.findAllByType(Skeleton)).toHaveLength(4)
  })

  // The first read's skeleton is the ready band's two columns, so nothing moves when figures land.
  test('is shaped as the band it waits for, two lines a side on their leadings', async () => {
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()
    await flush()

    const row = root.root.findByType(FigureRow)
    const bars = row.findAllByType(Skeleton)
    const lines = bars.map(bar => StyleSheet.flatten(hostParent(bar)!.props.style).height)
    const label = hostParent(hostParent(bars[0]!)!)
    expect(bars).toHaveLength(4)
    expect(hostParent(hostParent(bars[1]!)!)).toBe(label)
    expect(hostParent(hostParent(bars[2]!)!)).not.toBe(label)
    expect(hostParent(hostParent(bars[3]!)!)).toBe(hostParent(hostParent(bars[2]!)!))
    // At the text size, as the band's height counts its lines.
    const { fontScale } = Dimensions.get('window')
    const leading = (pt: number) => Math.ceil(pt * fontScale)
    const column = [leading(font.leading.lg), leading(font.leading.base)]
    expect(lines).toEqual([...column, ...column])
    // Each bar stands in the middle of its line, where the type it waits for is drawn.
    expect(bars.map(bar => StyleSheet.flatten(hostParent(bar)!.props.style).justifyContent)).toEqual([
      'center',
      'center',
      'center',
      'center',
    ])
    // Each bar is the height of its line's type, under the leading, so the lines read apart.
    const type = (pt: number) => Math.round(pt * fontScale)
    expect(bars.map(bar => bar.props.height)).toEqual([
      type(font.size.lg),
      type(font.size.base),
      type(font.size.lg),
      type(font.size.sm),
    ])
  })

  // Under the price the change and its period share a line, so their bars do too, and the skeleton
  // fits the band's stacked height.
  test('puts the change and period bars on one line under the price at large text', async () => {
    rates.mockImplementation(() => new Promise(() => undefined))
    const start = Dimensions.get('window')
    const window = { ...start, fontScale: 3.12 }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
    try {
      const root = await mount()
      await flush()

      const bars = root.root.findByType(FigureRow).findAllByType(Skeleton)
      const lineOf = (bar: ReactTestRenderer.ReactTestInstance) => hostParent(bar)!
      const holder = (bar: ReactTestRenderer.ReactTestInstance) => hostParent(lineOf(bar))!
      expect(bars).toHaveLength(4)
      expect(holder(bars[3]!)).toBe(holder(bars[2]!))
      expect(StyleSheet.flatten(holder(bars[2]!).props.style)).toMatchObject({
        flexDirection: 'row',
        gap: space.sm,
      })
      // The shared line is the Row primitive, not a style block of the band's own.
      const shared = root.root.findByType(FigureRow).findByType(Row)
      expect(shared.findAllByType(Skeleton)).toEqual([bars[2], bars[3]])
      const line = (pt: number) => Math.ceil(pt * window.fontScale)
      expect(bars.map(bar => StyleSheet.flatten(lineOf(bar).props.style).height)).toEqual([
        line(font.leading.lg),
        line(font.leading.base),
        line(font.leading.lg),
        line(font.leading.lg),
      ])
      const stack = StyleSheet.flatten(hostParent(holder(bars[0]!))!.props.style)
      expect(stack.flexDirection).toBe('column')
      const json = root.toJSON() as ReactTestRenderer.ReactTestRendererJSON
      const band = StyleSheet.flatten(json.props.style)
      const column = line(font.leading.lg) + line(font.leading.base)
      expect(band.height).toBe(column + Number(stack.gap) + line(font.leading.lg) + 2 * space.sm)
    } finally {
      ReactTestRenderer.act(() => Dimensions.set({ window: start, screen: start }))
    }
  })

  test('no answer at all, as offline after a restart, ends the skeleton with the wait', async () => {
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()

    await flush(SYNC_WAIT_MS - 1)
    expect(root.root.findAllByType(Skeleton)).toHaveLength(4)

    await flush(1)
    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(shownTexts(root)).toEqual([])
  })

  test('no connection at all ends it the same', async () => {
    connected.mockReturnValue(null)
    const root = await mount()

    await flush(SYNC_WAIT_MS)

    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('after a figure went, a read in flight draws no skeleton', async () => {
    const root = await mount()
    await flush()
    rates.mockImplementation(() => new Promise(() => undefined))

    await flush(PRICE_MAX_AGE_MS)

    expect(shownTexts(root)).not.toContain(price(600_000))
    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('after a failed first read, a later read in flight draws none either', async () => {
    rates.mockRejectedValueOnce(new Error('rates down'))
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()
    await flush()

    await flush(PRICE_READ_EVERY_MS)

    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('a figure that lands after the wait ran out still shows', async () => {
    const slow = hanging<Record<string, number>>()
    rates.mockReturnValueOnce(slow.promise)
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()
    connected.mockReturnValue(null)

    await flush(SYNC_WAIT_MS)
    await ReactTestRenderer.act(async () => {
      slow.resolve({ BRL: 600_000 })
    })
    await flush()

    expect(shownTexts(root)).toContain(price(600_000))
  })
})

describe('the band', () => {
  const band = (root: ReactTestRenderer.ReactTestRenderer) =>
    StyleSheet.flatten((root.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props.style)
  const bordered = (root: ReactTestRenderer.ReactTestRenderer) =>
    /"border(Top|Bottom|Left|Right)?Width":[1-9]/.test(JSON.stringify(root.toJSON()))

  test('has the bar fill and no border while it waits and with a figure', async () => {
    rates.mockImplementation(() => new Promise(() => undefined))
    const root = await mount()
    expect(band(root).backgroundColor).toBe(colors.surface)

    rates.mockResolvedValue({ BRL: 600_000 })
    await flush(PRICE_READ_EVERY_MS)
    expect(shownTexts(root)).toContain(price(600_000))
    expect(band(root).backgroundColor).toBe(colors.surface)
    expect(bordered(root)).toBe(false)
  })

  // A shrinking press would pull the band off the bar it is joined to, so it lights up as a row does.
  test('answers a press as a row, never by shrinking', async () => {
    const root = await mount()
    await flush()

    expect(targets(root)).toHaveLength(1)
    expect(root.root.findByType(Touch).props.feedback).toBe('row')
  })

  // The band is part of the block it forms with the tab bar, so a price that goes leaves the block's
  // edge where it was and only empties the band.
  test('keeps its fill and its height after a failure, with nothing inside and nothing to press', async () => {
    rates.mockRejectedValue(new Error('rates down'))
    const root = await mount()
    await flush()

    const { fontScale } = Dimensions.get('window')
    expect(band(root).backgroundColor).toBe(colors.surface)
    expect(band(root).height).toBe(priceStripHeight(fontScale, true))
    expect(shownTexts(root)).toEqual([])
    expect(root.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(targets(root)).toHaveLength(0)
  })

  test('names bitcoin strong over the price of one, and puts the change over its period across from them', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()

    const text = (said: string) => root.root.findAllByType(Text).find(node => node.props.children === said)!
    const style = (said: string) => StyleSheet.flatten(text(said).props.style)
    // The name leads in the default tone, bold and larger than the price line under it, which is
    // regular body type, muted like the period across from it.
    expect(style('Bitcoin')).toMatchObject({ color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.bold })
    expect(style(price(600_000))).toMatchObject({
      color: colors.textSecondary,
      fontSize: font.size.base,
      fontWeight: font.weight.regular,
    })
    // The change is as strong as the name and in its tone; the period under it is small and muted.
    expect(style('+2.00%')).toMatchObject({ color: colors.text, fontSize: font.size.lg, fontWeight: font.weight.bold })
    expect(style(period())).toMatchObject({ color: colors.textSecondary, fontSize: font.size.sm })
    // One box holds the name over the price, the other the change over its period, at the row's end.
    expect(hostParent(text(price(600_000)))).toBe(hostParent(text('Bitcoin')))
    expect(hostParent(text(period()))).toBe(hostParent(text('+2.00%')))
    expect(hostParent(text('+2.00%'))).not.toBe(hostParent(text('Bitcoin')))
    expect(StyleSheet.flatten(hostParent(text('+2.00%'))!.props.style).alignItems).toBe('flex-end')
    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), '+2.00%', period()])
  })

  // Each column is two lines on the same two leadings, so the change sits across from the name and
  // the period across from the price, whatever the size of each line's type.
  test('pairs its two columns line for line', async () => {
    series.mockResolvedValue(day(100, 102))
    const root = await mount()
    await flush()

    // The leading each text asks for, read off the outermost Txt or Figure that draws it, before
    // the half point a Figure gives back on iOS.
    const leading = (said: string) => {
      const node = root.root.findAll(
        n => (n.type === Txt || n.type === Figure) && n.props.children === said,
      )[0]!
      const role: Role = node.props.role ?? 'body'
      return StyleSheet.flatten([roles[role], node.props.style]).lineHeight
    }
    expect(leading('Bitcoin')).toBe(font.leading.lg)
    expect(leading('+2.00%')).toBe(leading('Bitcoin'))
    expect(leading(price(600_000))).toBe(font.leading.base)
    expect(leading(period())).toBe(leading(price(600_000)))
  })

  // A muted name would read as a caption; the word across from it says the figure is not current.
  test('keeps the name in the default tone and says the stale price is out of date', async () => {
    series.mockResolvedValue(day(100, 102))
    mockStale = true
    const root = await mount()
    await flush()

    const color = (said: string) =>
      StyleSheet.flatten(root.root.findAllByType(Text).find(node => node.props.children === said)!.props.style).color
    expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), i18n.t('home.priceNotCurrent')])
    expect(color('Bitcoin')).toBe(colors.text)
    expect(color(price(600_000))).toBe(colors.textSecondary)
    // The word stands on the name's line: the row aligns its columns at the top, so a one-line right
    // column is not centred between the name and the price.
    const word = root.root.findAllByType(Text).find(node => node.props.children === i18n.t('home.priceNotCurrent'))!
    const row = hostParent(hostParent(word)!)!
    expect(StyleSheet.flatten(row.props.style).alignItems).toBe('flex-start')
    // On the name's leading, so the word shares the name's line rather than a shorter caption line
    // set higher than the name.
    const said = root.root.findAll(n => n.type === Txt && n.props.children === i18n.t('home.priceNotCurrent'))[0]!
    expect(StyleSheet.flatten([roles[said.props.role as Role], said.props.style]).lineHeight).toBe(font.leading.lg)
  })

  // Draws the band at a text size too large for its columns side by side, then restores the window.
  const atLargestText = async (
    check: (root: ReactTestRenderer.ReactTestRenderer, fontScale: number) => void,
  ) => {
    const start = Dimensions.get('window')
    const window = { ...start, fontScale: 3.12 }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
    try {
      const root = await mount()
      await flush()
      check(root, window.fontScale)
    } finally {
      ReactTestRenderer.act(() => Dimensions.set({ window: start, screen: start }))
    }
  }
  const textOf = (root: ReactTestRenderer.ReactTestRenderer, said: string) =>
    root.root.findAllByType(Text).find(node => node.props.children === said)!

  // At a text size too large for both columns the right column goes under the price, at the start,
  // as one line: the change, then its period muted beside it, so the band is three lines, not four.
  test('puts the change and its period on one line under the price at large text', async () => {
    series.mockResolvedValue(day(100, 102))
    await atLargestText((root, fontScale) => {
      // One paragraph, the change and then its period, so the two share a baseline and shrink
      // together on one line.
      const paragraph = hostParent(textOf(root, period()))!
      const runs = [paragraph.props.children].flat()
      expect(runs[0]).toBe('+2.00%')
      expect(runs.indexOf('+2.00%')).toBeLessThan(runs.findIndex(run => typeof run === 'object'))
      expect(paragraph.props.numberOfLines).toBe(1)
      expect(paragraph.props.adjustsFontSizeToFit).toBe(true)
      expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), period()])
      // The change keeps the name's type and tone; the period beside it is small and muted, with no
      // leading of its own, so the paragraph's sets the one line the band counts.
      expect(StyleSheet.flatten(paragraph.props.style)).toMatchObject({
        color: colors.text,
        fontSize: font.size.lg,
        fontWeight: font.weight.bold,
      })
      const said = StyleSheet.flatten(textOf(root, period()).props.style)
      expect(said).toMatchObject({ color: colors.textSecondary, fontSize: font.size.sm })
      expect(said.lineHeight).toBeUndefined()
      const figureSide = hostParent(paragraph)!
      expect(StyleSheet.flatten(figureSide.props.style).alignItems).toBe('flex-start')
      const stack = StyleSheet.flatten(hostParent(figureSide)!.props.style)
      expect(stack.flexDirection).toBe('column')
      // Two lines on the left, the gap the stacked row draws, and the one line under them.
      const line = (pt: number) => Math.ceil(pt * fontScale)
      const column = line(font.leading.lg) + line(font.leading.base)
      expect(band(root).height).toBe(priceStripHeight(fontScale, false))
      const under = Number(stack.gap) + line(font.leading.lg)
      expect(band(root).height).toBe(column + under + 2 * space.sm)
      expect(figuresHeldOut(root.root)).toEqual([])
    })
  })

  // The word counts one line under the price too, so it shrinks on that line rather than wrap past
  // the band's edge, and it stands where the change would.
  test('says a stale price is out of date on one line under the price at large text', async () => {
    series.mockResolvedValue(day(100, 102))
    mockStale = true
    await atLargestText((root, fontScale) => {
      const word = textOf(root, i18n.t('home.priceNotCurrent'))
      expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000), i18n.t('home.priceNotCurrent')])
      expect(word.props.numberOfLines).toBe(1)
      expect(word.props.adjustsFontSizeToFit).toBe(true)
      expect(StyleSheet.flatten(word.props.style)).toMatchObject({
        color: colors.textSecondary,
        fontSize: font.size.sm,
      })
      const stack = hostParent(hostParent(word)!)!
      expect(StyleSheet.flatten(stack.props.style).flexDirection).toBe('column')
      expect(band(root).height).toBe(priceStripHeight(fontScale, false))
      expect(figuresHeldOut(root.root)).toEqual([])
    })
  })

  // With no change known the right column is empty under the price as beside it, and the band keeps
  // its height for the text size.
  test('with no change, puts nothing under the price at a large text size', async () => {
    await atLargestText((root, fontScale) => {
      expect(shownTexts(root)).toEqual(['Bitcoin', price(600_000)])
      expect(band(root).height).toBe(priceStripHeight(fontScale, false))
    })
  })

  // Side by side the word may wrap, since the band counts two lines for its column there.
  test('lets the out of date word wrap between words side by side', async () => {
    series.mockResolvedValue(day(100, 102))
    mockStale = true
    const root = await mount()
    await flush()

    const word = textOf(root, i18n.t('home.priceNotCurrent'))
    expect(word.props.numberOfLines).toBeUndefined()
    const whole = root.root.findAll(n => n.type === Txt && n.props.wholeWords === true)
    expect(whole.map(n => n.props.children)).toContain(i18n.t('home.priceNotCurrent'))
  })
})

test('the strip grows with the text, stacks with it, and never drops below the touch floor', () => {
  expect(priceStripHeight(1, true)).toBeGreaterThanOrEqual(44)
  expect(priceStripHeight(2, true)).toBeGreaterThan(priceStripHeight(1, true))
  expect(priceStripHeight(2, false)).toBeGreaterThan(priceStripHeight(2, true))
  // Two lines a column: the 18pt name or change on its 24pt leading over a 24pt line, with the band's
  // air above and below; stacked, the change and its period on one line under the first column.
  expect(priceStripHeight(1, true)).toBe(font.leading.lg + font.leading.base + 2 * space.sm)
  expect(priceStripHeight(1, false)).toBe(
    font.leading.lg + font.leading.base + space.xs + font.leading.lg + 2 * space.sm,
  )
  // At the largest iOS size the stacked band is three lines, not four.
  const line = (pt: number) => Math.ceil(pt * 3.12)
  expect(priceStripHeight(3.12, false)).toBe(
    line(font.leading.lg) + line(font.leading.base) + space.xs + line(font.leading.lg) +
      2 * space.sm,
  )
})

describe('on a blurred Home', () => {
  test('nothing reads and no minute runs, and focus reads at once', async () => {
    mockFocused = false
    const root = await mount()
    await flush(PRICE_READ_EVERY_MS)
    expect(rates).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => {
      root.update(<PriceStrip onOpen={opened} focused beat={0} stale={false} />)
    })
    await flush()
    expect(rates).toHaveBeenCalledTimes(1)
  })

  test('a blur stops the minute, and the figure stays', async () => {
    const root = await mount()
    await flush()
    await ReactTestRenderer.act(async () => {
      root.update(<PriceStrip onOpen={opened} focused={false} beat={0} stale={false} />)
    })

    await flush(PRICE_READ_EVERY_MS)

    expect(rates).toHaveBeenCalledTimes(1)
    expect(shownTexts(root)).toContain(price(600_000))
  })

  test('coming back from the background on a blurred Home starts nothing', async () => {
    const root = await mount()
    await flush()
    await ReactTestRenderer.act(async () => {
      root.update(<PriceStrip onOpen={opened} focused={false} beat={0} stale={false} />)
    })
    await toApp('active')
    await flush(PRICE_READ_EVERY_MS)

    expect(rates).toHaveBeenCalledTimes(1)
  })
})

test('saving the display currency tells the line after the write, so its read sees the new one', async () => {
  const settings = jest.requireActual('../src/wallet/settings')
  const notices = jest.requireActual('../src/wallet/displayCurrencyNotice')
  const heard = jest.fn()
  const off = notices.onDisplayCurrencyChanged(() => heard(settings.loadDisplayCurrency()))

  await settings.saveDisplayCurrency('EUR')
  off()

  expect(heard).toHaveBeenCalledTimes(1)
  await expect(heard.mock.calls[0][0]).resolves.toBe('EUR')
})

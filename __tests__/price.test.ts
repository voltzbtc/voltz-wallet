import RNFS from 'react-native-fs'
import {
  downsample,
  fetchBtcPriceSeries,
  onDaySeriesFetched,
  isCacheFresh,
  parseKrakenOhlc,
  isScrubGesture,
  dayChangePct,
  periodChange,
  shownPercent,
  signedPercent,
  rescaleToSpot,
  scrubIndex,
  type PricePoint,
} from '../src/wallet/price'

// Kraken candles are [time, open, high, low, close, vwap, volume, count], keyed by its own pair name.
const krakenBody = (candles: (string | number)[][]) => ({
  error: [],
  result: { XXBTZUSD: candles, last: 1786800000 },
})

const candle = (seconds: number, close: string) => [seconds, '1', '2', '0', close, '1', '1', 1]

type FsMock = typeof RNFS & { __reset: () => void }
const fs = RNFS as FsMock

function mockFetch(impl: () => Promise<unknown>) {
  ;(global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
    ok: true,
    json: impl,
  }))
}

beforeEach(() => {
  fs.__reset()
  jest.restoreAllMocks()
})

describe('parseKrakenOhlc', () => {
  it('reads closes as [ms, close], finding the pair key by shape', () => {
    expect(parseKrakenOhlc(krakenBody([candle(1000, '62000.5'), candle(2000, '63000')]))).toEqual([
      [1000000, 62000.5],
      [2000000, 63000],
    ])
  })

  it('returns [] for shapes it does not recognize, never a partial curve', () => {
    expect(parseKrakenOhlc(null)).toEqual([])
    expect(parseKrakenOhlc({ error: ['EGeneral:Too many requests'] })).toEqual([])
    expect(parseKrakenOhlc({ result: null })).toEqual([])
    expect(parseKrakenOhlc({ result: { last: 1 } })).toEqual([])
    expect(parseKrakenOhlc('{}')).toEqual([])
  })

  it('drops individual candles that are malformed, keeping the good ones', () => {
    const body = krakenBody([
      candle(1000, '62000'),
      [2000, '1', '2', '0'], // truncated, no close
      candle(3000, 'not-a-number'),
      candle(4000, '0'), // a price of zero does not exist, so it is dropped
      candle(5000, '64000'),
    ])
    expect(parseKrakenOhlc(body)).toEqual([
      [1000000, 62000],
      [5000000, 64000],
    ])
  })
})

describe('downsample', () => {
  it('keeps the first and last item, which are the two the chart states out loud', () => {
    const items = Array.from({ length: 500 }, (_, i) => i)
    const out = downsample(items, 64)
    expect(out).toHaveLength(64)
    expect(out[0]).toBe(0)
    expect(out[out.length - 1]).toBe(499)
  })

  it('leaves a series shorter than the cap untouched', () => {
    expect(downsample([1, 2, 3], 64)).toEqual([1, 2, 3])
  })

  it('never returns fewer points than asked when the series is long enough', () => {
    expect(downsample(Array.from({ length: 65 }, (_, i) => i), 64)).toHaveLength(64)
  })
})

describe('rescaleToSpot', () => {
  it('lands the last point exactly on the SDK rate and scales the rest with it', () => {
    const points = rescaleToSpot(
      [
        [1, 100],
        [2, 200],
      ],
      500,
    )
    expect(points[points.length - 1].v).toBe(500)
    expect(points[0].v).toBe(250)
  })

  it('preserves the shape: the percentage move survives the currency change', () => {
    const usd: [number, number][] = [
      [1, 50000],
      [2, 55000],
      [3, 60000],
    ]
    const inBrl = rescaleToSpot(usd, 313000)
    expect(periodChange(inBrl).pct).toBeCloseTo(20, 10)
  })

  it('refuses to invent a scale when there is nothing to anchor to', () => {
    expect(rescaleToSpot([], 500)).toEqual([])
    expect(rescaleToSpot([[1, 100]], 0)).toEqual([])
    expect(rescaleToSpot([[1, 100]], -3)).toEqual([])
    expect(rescaleToSpot([[1, 0]], 500)).toEqual([])
  })
})

describe('periodChange', () => {
  it('measures the last point against the first', () => {
    const change = periodChange([
      { t: 1, v: 200 },
      { t: 2, v: 150 },
      { t: 3, v: 250 },
    ])
    expect(change.abs).toBe(50)
    expect(change.pct).toBeCloseTo(25, 10)
  })

  it('reports a fall as negative', () => {
    expect(periodChange([{ t: 1, v: 100 }, { t: 2, v: 75 }]).pct).toBeCloseTo(-25, 10)
  })

  it('reports no change for a window that has none to measure', () => {
    expect(periodChange([])).toEqual({ abs: 0, pct: 0 })
    expect(periodChange([{ t: 1, v: 100 }])).toEqual({ abs: 0, pct: 0 })
    expect(periodChange([{ t: 1, v: 0 }, { t: 2, v: 100 }])).toEqual({ abs: 0, pct: 0 })
  })
})

describe('scrubIndex', () => {
  // A 100pt plot with a 5pt inset on each side (the card default) and 11 points.
  const at = (x: number) => scrubIndex(x, 110, 11, 5)

  it('maps the touch to the nearest point', () => {
    expect(at(5)).toBe(0)
    expect(at(55)).toBe(5)
    expect(at(105)).toBe(10)
  })

  it('clamps at both ends, so dragging past the edge reads the first or last point', () => {
    expect(at(-200)).toBe(0)
    expect(at(9999)).toBe(10)
  })

  it('has nothing to read without a curve or before the layout measured', () => {
    expect(scrubIndex(50, 110, 1, 5)).toBeNull()
    expect(scrubIndex(50, 110, 0, 5)).toBeNull()
    expect(scrubIndex(50, 0, 11, 5)).toBeNull()
    // An inset wider than the width leaves a negative plot with nothing to map.
    expect(scrubIndex(50, 8, 11, 5)).toBeNull()
  })
})

describe('isScrubGesture', () => {
  it('is a scrub when the finger commits sideways', () => {
    expect(isScrubGesture(30, 4)).toBe(true)
    expect(isScrubGesture(-30, 4)).toBe(true)
  })

  it('is NOT a scrub when the finger goes down the page: that touch belongs to the scroll', () => {
    expect(isScrubGesture(1, 40)).toBe(false)
    expect(isScrubGesture(10, 12)).toBe(false)
    expect(isScrubGesture(0, -25)).toBe(false)
  })

  it('ignores a resting finger', () => {
    expect(isScrubGesture(0, 0)).toBe(false)
    expect(isScrubGesture(2, 0)).toBe(false)
    expect(isScrubGesture(1.5, 0.2)).toBe(false)
  })
})

describe('isCacheFresh', () => {
  it('is fresh inside the period TTL and stale past it', () => {
    const now = 10_000_000
    // The TTL is 5 min for 1D and 6 h for 1Y.
    expect(isCacheFresh({ fetchedAt: now - 4 * 60_000, closes: [] }, '1D', now)).toBe(true)
    expect(isCacheFresh({ fetchedAt: now - 6 * 60_000, closes: [] }, '1D', now)).toBe(false)
    expect(isCacheFresh({ fetchedAt: now - 6 * 60_000, closes: [] }, '1Y', now)).toBe(true)
  })

  it('treats a missing entry as stale', () => {
    expect(isCacheFresh(undefined, '1D', 1)).toBe(false)
  })
})

describe('fetchBtcPriceSeries', () => {
  it('tells of a new 1D series, and not of a cached read or another period', async () => {
    const heard = jest.fn()
    const off = onDaySeriesFetched(heard)
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))

    await fetchBtcPriceSeries('1W', 310000, 1_000_000)
    expect(heard).not.toHaveBeenCalled()
    await fetchBtcPriceSeries('1D', 310000, 1_000_000)
    expect(heard).toHaveBeenCalledTimes(1)
    await fetchBtcPriceSeries('1D', 310000, 1_060_000)
    expect(heard).toHaveBeenCalledTimes(1)

    off()
    await fetchBtcPriceSeries('1D', 310000, 10_000_000)
    expect(heard).toHaveBeenCalledTimes(1)
  })

  // A listener reads the cache again, so telling of a series the disk refused would refetch forever.
  it('tells of no 1D series the cache could not keep, and still answers with it', async () => {
    const heard = jest.fn()
    const off = onDaySeriesFetched(heard)
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error('ENOSPC'))

    const points = await fetchBtcPriceSeries('1D', 310000, 1_000_000)
    off()

    expect(heard).not.toHaveBeenCalled()
    expect(points?.[points.length - 1].v).toBe(310000)
  })

  it('fetches, caches, and anchors the curve to the given spot', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    const points = await fetchBtcPriceSeries('1D', 310000, 1_000_000)

    expect(points).not.toBeNull()
    expect(points?.[points.length - 1].v).toBe(310000)
    expect(points?.[0].v).toBeCloseTo(300000, 6)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('serves a fresh cache without touching the network', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    await fetchBtcPriceSeries('1D', 310000, 1_000_000)

    const again = await fetchBtcPriceSeries('1D', 310000, 1_060_000)
    expect(again).not.toBeNull()
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('rescales a cached series to a new currency without a new request', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    await fetchBtcPriceSeries('1D', 310000, 1_000_000)

    const inUsd = await fetchBtcPriceSeries('1D', 62000, 1_060_000)
    expect(inUsd?.[inUsd.length - 1].v).toBe(62000)
    expect(global.fetch).toHaveBeenCalledTimes(1)
  })

  it('refetches once the cache goes stale', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    await fetchBtcPriceSeries('1D', 310000, 1_000_000)

    await fetchBtcPriceSeries('1D', 310000, 1_600_000)
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('falls back to a STALE cache when the network fails, instead of showing nothing', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    await fetchBtcPriceSeries('1D', 310000, 1_000_000)
    ;(global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('offline')
    })

    const stale = await fetchBtcPriceSeries('1D', 310000, 9_000_000)
    expect(stale).not.toBeNull()
    expect(stale?.[stale.length - 1].v).toBe(310000)
  })

  it('returns null when there is neither network nor cache', async () => {
    ;(global as unknown as { fetch: unknown }).fetch = jest.fn(async () => {
      throw new Error('offline')
    })
    expect(await fetchBtcPriceSeries('1M', 310000, 1_000_000)).toBeNull()
  })

  it('returns null on a non-2xx (the rate limiter answering) without caching it', async () => {
    ;(global as unknown as { fetch: unknown }).fetch = jest.fn(async () => ({
      ok: false,
      json: async () => ({}),
    }))
    expect(await fetchBtcPriceSeries('1D', 310000, 1_000_000)).toBeNull()
    expect(await RNFS.exists('/mock/Documents/price-cache.json')).toBe(false)
  })

  it('returns null when the SDK has no rate to anchor to, even with candles in hand', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    expect(await fetchBtcPriceSeries('1D', 0, 1_000_000)).toBeNull()
  })

  it('survives a corrupt cache file by refetching', async () => {
    await RNFS.writeFile('/mock/Documents/price-cache.json', '{not json', 'utf8')
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))

    const points = await fetchBtcPriceSeries('1D', 310000, 1_000_000)
    expect(points?.[points.length - 1].v).toBe(310000)
  })

  it('keeps each period in its own cache slot', async () => {
    mockFetch(async () => krakenBody([candle(1000, '60000'), candle(2000, '62000')]))
    await fetchBtcPriceSeries('1D', 310000, 1_000_000)
    await fetchBtcPriceSeries('1Y', 310000, 1_000_000)

    expect(global.fetch).toHaveBeenCalledTimes(2)
    const raw = JSON.parse(await RNFS.readFile('/mock/Documents/price-cache.json', 'utf8'))
    expect(Object.keys(raw).sort()).toEqual(['1D', '1Y'])
  })
})

describe('dayChangePct', () => {
  const NOW = 1_800_000_000_000
  const HOUR = 3_600_000
  const series = (spanHours: number, endAgoMin: number): PricePoint[] => {
    const end = NOW - endAgoMin * 60_000
    return [
      { t: end - spanHours * HOUR, v: 100 },
      { t: end, v: 103 },
    ]
  }

  it('states the change of a series that covers the last day', () => {
    expect(dayChangePct(series(23.92, 3), NOW)).toBeCloseTo(3)
  })

  it('says nothing of a series too short to reach a day back', () => {
    expect(dayChangePct(series(22.9, 3), NOW)).toBeNull()
  })

  it('says nothing of a series that ended long ago, as a stale cache answers', () => {
    expect(dayChangePct(series(24, 31), NOW)).toBeNull()
    expect(dayChangePct(series(24, 30), NOW)).toBeCloseTo(3)
  })

  it('says nothing below two points or from a first point no price can be', () => {
    expect(dayChangePct([], NOW)).toBeNull()
    expect(dayChangePct([{ t: NOW, v: 100 }], NOW)).toBeNull()
    expect(
      dayChangePct(
        [
          { t: NOW - 24 * HOUR, v: 0 },
          { t: NOW, v: 100 },
        ],
        NOW,
      ),
    ).toBeNull()
  })
})

describe('shownPercent', () => {
  it('takes a change too small to draw to zero, so it carries no sign of a fall', () => {
    expect(shownPercent(-0.004)).toBe(0)
    expect(Object.is(shownPercent(-0.004), -0)).toBe(false)
    expect(signedPercent(shownPercent(-0.004), 'en-US')).toBe('+0.00')
  })

  it('keeps the sign of a change that draws as a digit', () => {
    expect(shownPercent(-0.006)).toBe(-0.01)
    expect(shownPercent(0.006)).toBe(0.01)
    expect(shownPercent(-1.234)).toBe(-1.23)
  })

  // A tie rounds away from zero, as Intl does when it draws the digits, so a fall drawn as 0.01 is red.
  it('rounds a tie the way the digits are drawn', () => {
    expect(shownPercent(-0.125)).toBe(-0.13)
    expect(signedPercent(shownPercent(-0.125), 'en-US')).toBe(signedPercent(-0.125, 'en-US'))
  })
})

describe('signedPercent', () => {
  it('signs a rise, and flat, with the plus', () => {
    expect(signedPercent(1.5, 'en-US')).toBe('+1.50')
    expect(signedPercent(0, 'en-US')).toBe('+0.00')
  })

  it('signs a fall with U+2212, never a hyphen', () => {
    expect(signedPercent(-1.5, 'en-US')).toBe('\u22121.50')
  })

  it("writes the digits the locale's way", () => {
    expect(signedPercent(1.5, 'de')).toBe('+1,50')
  })
})

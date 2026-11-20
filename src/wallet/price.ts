import RNFS from 'react-native-fs'

// The SDK fiat feed reports only the current rate, so the curve comes from Kraken's keyless OHLC
// endpoint, rescaled to end on that rate. Sources ruled out live in docs/price-chart.md.

const OHLC_URL = 'https://api.kraken.com/0/public/OHLC'
const TIMEOUT_MS = 10000
const CACHE_FILE = `${RNFS.DocumentDirectoryPath}/price-cache.json`

// The chart is ~340pt wide, so extra points buy invisible detail at the cost of path length.
const MAX_POINTS = 64

export type PricePeriod = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL'

export const PRICE_PERIODS: PricePeriod[] = ['1D', '1W', '1M', '3M', '1Y', 'ALL']

/** `t` is epoch MILLISECONDS and `v` is already in the display currency. */
export type PricePoint = { t: number; v: number }

// Kraken caps a response at 720 candles, so each period picks the coarsest interval covering it.
const SPEC: Record<PricePeriod, { interval: number; take: number | null }> = {
  '1D': { interval: 5, take: 288 },
  '1W': { interval: 60, take: 168 },
  '1M': { interval: 240, take: 180 },
  '3M': { interval: 240, take: 540 },
  '1Y': { interval: 1440, take: 365 },
  ALL: { interval: 21600, take: null },
}

// Longer windows barely move within a session, and an avoided call never meets the rate limiter.
const TTL_MS: Record<PricePeriod, number> = {
  '1D': 5 * 60 * 1000,
  '1W': 30 * 60 * 1000,
  '1M': 6 * 60 * 60 * 1000,
  '3M': 6 * 60 * 60 * 1000,
  '1Y': 6 * 60 * 60 * 1000,
  ALL: 6 * 60 * 60 * 1000,
}

// Closes in USD as [epochMs, close], cached in that unit so switching currency costs no request.
type Closes = [number, number][]

type CacheEntry = { fetchedAt: number; closes: Closes }
type Cache = Partial<Record<PricePeriod, CacheEntry>>

// Both endpoints survive the sampling, since the chart states the period start and the price now.
export function downsample<T>(items: T[], max: number): T[] {
  if (max < 2 || items.length <= max) {
    return items.slice()
  }
  const step = (items.length - 1) / (max - 1)
  const out: T[] = []
  for (let i = 0; i < max; i++) {
    out.push(items[Math.round(i * step)])
  }
  return out
}

// Kraken keys the result by its own pair name (XXBTZUSD), so the key has to be discovered.
export function parseKrakenOhlc(json: unknown): Closes {
  if (typeof json !== 'object' || json === null) {
    return []
  }
  const result = (json as { result?: unknown }).result
  if (typeof result !== 'object' || result === null) {
    return []
  }
  const candles = Object.entries(result as Record<string, unknown>).find(
    ([key, value]) => key !== 'last' && Array.isArray(value),
  )?.[1]
  if (!Array.isArray(candles)) {
    return []
  }
  const closes: Closes = []
  for (const candle of candles) {
    if (!Array.isArray(candle) || candle.length < 5) {
      continue
    }
    const seconds = Number(candle[0])
    const close = Number(candle[4])
    if (!Number.isFinite(seconds) || !Number.isFinite(close) || close <= 0) {
      continue
    }
    closes.push([seconds * 1000, close])
  }
  return closes
}

// Nothing to anchor against yields [], because an invented scale is worse than no chart at all.
export function rescaleToSpot(closes: Closes, spot: number): PricePoint[] {
  if (closes.length === 0 || !(spot > 0)) {
    return []
  }
  const last = closes[closes.length - 1][1]
  if (!(last > 0)) {
    return []
  }
  const factor = spot / last
  return closes.map(([t, v]) => ({ t, v: v * factor }))
}

export function periodChange(points: PricePoint[]): { abs: number; pct: number } {
  if (points.length < 2) {
    return { abs: 0, pct: 0 }
  }
  const first = points[0].v
  const last = points[points.length - 1].v
  if (!(first > 0)) {
    return { abs: 0, pct: 0 }
  }
  return { abs: last - first, pct: ((last - first) / first) * 100 }
}

// The series has to reach back a day and end about now. A cached series past its time still draws a
// chart as what it is, but its first point says nothing of 24 hours ago. A series of 288 five-minute
// candles spans 23 h 55 min.
const DAY_SPAN_MS = 23 * 60 * 60 * 1000
const DAY_END_MAX_AGE_MS = 30 * 60 * 1000

// The change over the last 24 hours, or null when the series cannot state it. The series moves in USD
// and is rescaled onto the spot, as the asset screen's chart is, so this is bitcoin's own move.
export function dayChangePct(points: PricePoint[], nowMs: number): number | null {
  if (points.length < 2) {
    return null
  }
  const first = points[0]
  const last = points[points.length - 1]
  if (last.t - first.t < DAY_SPAN_MS || nowMs - last.t > DAY_END_MAX_AGE_MS || !(first.v > 0)) {
    return null
  }
  return periodChange(points).pct
}

// The change at the two decimals a screen states it with, so the sign and the colour follow the figure
// drawn and a fall too small to show reads as no change. toFixed rounds the exact value half away from
// zero on a magnitude, as Intl's default does, so the two never disagree on a tie.
export function shownPercent(pct: number): number {
  const magnitude = Number(Math.abs(pct).toFixed(2))
  return magnitude === 0 ? 0 : Math.sign(pct) * magnitude
}

// The sign and two decimals in the locale's digits, for the `asset.delta` string, which places the
// percent sign. The minus is U+2212, as wide as the plus, since a hyphen reads as a dash beside a
// figure.
export function signedPercent(pct: number, locale: string): string {
  const digits = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return `${pct >= 0 ? '+' : '\u2212'}${digits.format(Math.abs(pct))}`
}

export function scrubIndex(x: number, width: number, count: number, padX: number): number | null {
  const plot = width - padX * 2
  if (count < 2 || plot <= 0) {
    return null
  }
  const ratio = (x - padX) / plot
  return Math.max(0, Math.min(count - 1, Math.round(ratio * (count - 1))))
}

// Kept small, since reading a curve starts with a tiny sideways move.
const SCRUB_MIN_DX = 2

// The chart sits in a scroll view, so the gesture is taken only once the finger commits sideways.
export function isScrubGesture(dx: number, dy: number): boolean {
  return Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > SCRUB_MIN_DX
}

export function isCacheFresh(entry: CacheEntry | undefined, period: PricePeriod, nowMs: number): boolean {
  return entry !== undefined && nowMs - entry.fetchedAt < TTL_MS[period]
}

async function readCache(): Promise<Cache> {
  try {
    if (!(await RNFS.exists(CACHE_FILE))) {
      return {}
    }
    const parsed: unknown = JSON.parse(await RNFS.readFile(CACHE_FILE, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Cache) : {}
  } catch {
    return {}
  }
}

// Answers whether the entry reached the disk. A cache that cannot be written is a slower app, not a
// broken one, so the failure goes no further than the answer.
async function writeCache(period: PricePeriod, entry: CacheEntry): Promise<boolean> {
  try {
    const next = { ...(await readCache()), [period]: entry }
    await RNFS.writeFile(CACHE_FILE, JSON.stringify(next), 'utf8')
    return true
  } catch {
    return false
  }
}

async function fetchCloses(period: PricePeriod): Promise<Closes> {
  const { interval, take } = SPEC[period]
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${OHLC_URL}?pair=XBTUSD&interval=${interval}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      return []
    }
    const closes = parseKrakenOhlc(await res.json())
    const window = take === null ? closes : closes.slice(-take)
    return downsample(window, MAX_POINTS)
  } catch {
    return []
  } finally {
    clearTimeout(timer)
  }
}

const daySeriesListeners = new Set<() => void>()

// Told when a newer 1D series reaches the cache, whoever asked for it, so what states the day's change
// from an earlier read can read again and keep agreeing with the chart.
export function onDaySeriesFetched(listener: () => void): () => void {
  daySeriesListeners.add(listener)
  return () => {
    daySeriesListeners.delete(listener)
  }
}

// Cache first, network second, stale cache last, as an expired series answers better than an empty
// screen. Null drops the chart alone and leaves the caller showing the price.
export async function fetchBtcPriceSeries(
  period: PricePeriod,
  spot: number,
  nowMs: number = Date.now(),
): Promise<PricePoint[] | null> {
  const cache = await readCache()
  const cached = cache[period]
  if (isCacheFresh(cached, period, nowMs) && cached) {
    const points = rescaleToSpot(cached.closes, spot)
    return points.length > 0 ? points : null
  }

  const fresh = await fetchCloses(period)
  if (fresh.length > 0) {
    // A listener reads the cache again, so telling of a series the disk refused would send it back to
    // the network, and its fetch would tell again, with no end.
    const written = await writeCache(period, { fetchedAt: nowMs, closes: fresh })
    if (written && period === '1D') {
      daySeriesListeners.forEach(listener => listener())
    }
    const points = rescaleToSpot(fresh, spot)
    return points.length > 0 ? points : null
  }

  if (cached && cached.closes.length > 0) {
    const points = rescaleToSpot(cached.closes, spot)
    return points.length > 0 ? points : null
  }
  return null
}

import type { FiatCurrency } from './fiat'

// How often the strip on Home reads the price, and how long a figure counts as current after the read
// that brought it. Past this, or after a read that failed, the strip keeps the last price muted and
// states no change.
export const PRICE_READ_EVERY_MS = 60_000
export const PRICE_MAX_AGE_MS = 180_000

export type PriceLine =
  // No read has answered yet: the one state that may draw a skeleton.
  | { status: 'first' }
  | { status: 'none' }
  // `current` says the newest read answered and is within the age. `readAt` names that read.
  | { status: 'price'; rate: number; currency: FiatCurrency; current: boolean; readAt: number }

// A figure a read went out for at `readAt` no longer counts as current. The age counts from the moment the read
// left, not from its answer, so a slow answer spends its own time from the three minutes.
export function priceIsOld(readAt: number, now: number): boolean {
  return now - readAt >= PRICE_MAX_AGE_MS
}

// What a feed says for a currency. A rate that is absent or that no price can be is nothing to show.
export function rateFor(rates: Record<string, number>, currency: FiatCurrency): number | null {
  const rate = rates[currency]
  return typeof rate === 'number' && Number.isFinite(rate) && rate > 0 ? rate : null
}

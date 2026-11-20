// Flashnet pays USDB holders a daily reward in sats straight to their Spark wallet, and Voltz is not
// in that path. This module only reads; it signs no endorsement and sets no host fee
// (docs/principles.md).

const BASE_URL = 'https://rewards.flashnet.xyz/v1'
const TIMEOUT_MS = 8000

export type UsdbRewards = {
  /** Display units (e.g. "1250.5"), not base units. */
  balance: string
  /** Annual rate in percent, not a fraction. */
  percent: number
  /** Sats projected for today at that rate, an estimate rather than a promise. */
  estimatedSatsToday: number
}

export type UsdbPayout = {
  /** YYYY-MM-DD, as returned by the API. */
  day: string
  /** Own rewards plus anything delegated to this pubkey. */
  sats: number
  paid: boolean
}

// Spark identity pubkey as hex, compressed (66 chars) or uncompressed (130). Validated rather than
// trusted because the value goes into a URL path, where a bad value could reshape the request.
export function isSparkPubkey(value: string): boolean {
  return /^[0-9a-f]{66}$/i.test(value) || /^[0-9a-f]{130}$/i.test(value)
}

// u128 balances arrive as strings, so both JSON shapes are accepted.
function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// An unrecognized shape returns null, so a changed API shows no rewards instead of fake zeros.
export function parseUsdbRewards(json: unknown): UsdbRewards | null {
  if (!isRecord(json)) {
    return null
  }
  const balance = isRecord(json.usdbBalance) ? json.usdbBalance.display : undefined
  // The value must be typed, not merely present, since a null or object `display` sails through a
  // presence check and reaches the screen as the literal text "null" where a balance belongs.
  if ((typeof balance !== 'string' && typeof balance !== 'number') || json.rewardsPercent === undefined) {
    return null
  }
  return {
    balance: String(balance),
    percent: toNumber(json.rewardsPercent),
    estimatedSatsToday: toNumber(json.estimatedSatsToday),
  }
}

// Unknown entries are dropped rather than rendered half-empty.
export function parseUsdbPayouts(json: unknown): UsdbPayout[] {
  if (!isRecord(json) || !Array.isArray(json.payouts)) {
    return []
  }
  const payouts: UsdbPayout[] = []
  for (const entry of json.payouts) {
    if (!isRecord(entry) || typeof entry.day !== 'string') {
      continue
    }
    payouts.push({
      day: entry.day,
      sats: toNumber(entry.payoutSats),
      paid: entry.status === 'paid',
    })
  }
  return payouts
}

// GETs a path under the rewards API. Null on any failure, whether a network error, a timeout, a non-2xx
// (the API answers 400 for addresses it excludes, such as LP pools) or a body that isn't JSON.
// Rewards are decoration on a wallet screen; nothing here is worth failing the screen over.
async function getJson(path: string): Promise<unknown | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      return null
    }
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// Today's standing for a holder, or null when there is nothing to show (invalid pubkey, excluded
// address, holder below the 10 USDB minimum, API unreachable).
export async function fetchUsdbRewards(pubkey: string): Promise<UsdbRewards | null> {
  if (!isSparkPubkey(pubkey)) {
    return null
  }
  return parseUsdbRewards(await getJson(`/rewards/${encodeURIComponent(pubkey)}`))
}

// The most recent daily payouts, newest first as the API returns them. Empty on any failure.
export async function fetchUsdbPayouts(pubkey: string, limit = 10): Promise<UsdbPayout[]> {
  if (!isSparkPubkey(pubkey)) {
    return []
  }
  const path = `/rewards/${encodeURIComponent(pubkey)}/payouts?limit=${encodeURIComponent(limit)}`
  return parseUsdbPayouts(await getJson(path))
}

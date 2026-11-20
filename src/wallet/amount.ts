// Bitcoin's total supply in sats, which no legitimate value can exceed.
const MAX_SATS = 2_100_000_000_000_000

// Returns null instead of throwing because the source is always user input, where an
// invalid value is the screen's normal flow rather than an exception. Accepts digits only,
// so decimals, sign, thousands separators and scientific notation are rejected
// without extra checks.
export function parseAmountSat(input: string): number | null {
  const trimmed = input.trim()
  if (!/^\d+$/.test(trimmed)) {
    return null
  }

  const value = Number(trimmed)
  if (value <= 0 || value > MAX_SATS) {
    return null
  }
  return value
}

// A decimal amount (tokens have decimal places), e.g. "1.5". Returns null on the normal
// invalid-input path rather than throwing.
export function parseConvertAmount(input: string): number | null {
  const trimmed = input.trim().replace(',', '.')
  if (!/^\d*\.?\d+$/.test(trimmed)) {
    return null
  }
  const value = Number(trimmed)
  if (!(value > 0) || !Number.isFinite(value)) {
    return null
  }
  return value
}

const SATS_PER_BTC = 100_000_000

export function formatBtc(sats: number): string {
  return (sats / SATS_PER_BTC).toFixed(8)
}

// Trailing zeros trimmed (100000 -> "0.001"), for compact display where the full 8 decimals
// would be noise.
export function formatBtcTrim(sats: number): string {
  const value = (sats / SATS_PER_BTC).toFixed(8)
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

// Sats keep the Bitcoin convention in every language, a no-break space between groups, so a figure in
// sats never reads like a decimal and never wraps inside a group. Every other number takes the
// language's separators. A sat has no fraction, so one passing through, as a count-up animation sends,
// rounds to the whole sat before grouping.
export function formatSats(sats: number): string {
  return groupDigits(String(Math.round(sats)))
}

// The grouping formatSats draws, on a run of digits, so a figure past a double's precision is
// grouped without passing through one.
export function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')
}

export type AmountBounds = { min?: number; max?: number }

// A cross-chain route bounds a send in sats and, separately, in dollars of order value; the tighter
// of each pair binds. The dollar side needs a rate and is skipped without one, since the route
// still enforces it and refuses at prepare. The floor rounds up and the ceiling down, so the keypad
// never lets through an amount the route would refuse on this side of the conversion.
export function crossChainBoundsSat(
  route: { minSat?: number; maxSat?: number; minUsdCents?: number; maxUsdCents?: number },
  usdPerBtc: number | undefined,
): AmountBounds {
  const rate = usdPerBtc !== undefined && Number.isFinite(usdPerBtc) && usdPerBtc > 0 ? usdPerBtc : undefined
  const toSats = (cents: number) => (cents / 100 / (rate as number)) * 100_000_000
  const usdMin = rate && route.minUsdCents !== undefined ? Math.ceil(toSats(route.minUsdCents)) : undefined
  const usdMax = rate && route.maxUsdCents !== undefined ? Math.floor(toSats(route.maxUsdCents)) : undefined
  const pick = (a: number | undefined, b: number | undefined, f: (x: number, y: number) => number) =>
    a === undefined ? b : b === undefined ? a : f(a, b)
  return { min: pick(route.minSat, usdMin, Math.max), max: pick(route.maxSat, usdMax, Math.min) }
}

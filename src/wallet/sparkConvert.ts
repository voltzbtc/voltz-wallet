import type { SparkToken } from './spark'
import { localizeAmount } from './fiat'
import type { CatalogToken } from './tokenPrefs'
import { BITCOIN_ASSET_ID } from './assets'
import { DEFAULT_TOKENS, byAssetOrder, knownToken } from './tokens'

// `id` is 'btc' for Bitcoin, which has no token identifier, otherwise the token's identifier.
export type SparkConvertAsset = {
  id: string
  ticker: string
  name: string
  decimals: number
  // Fiat peg for the live estimate. Absent for BTC and for unpegged tokens, which get no estimate.
  fiatId?: string
}

const BTC_ID = 'btc'

// Entered in sats, which IS the SDK's base unit for BTC, so decimals is 0 and '4200' is 4200 sats.
export const SPARK_BTC: SparkConvertAsset = { id: BTC_ID, ticker: 'sats', name: 'Bitcoin', decimals: 0 }

// The peg comes from the registry by identifier, so a held or added DePix is priced like a default.
function tokenToAsset(
  token: Pick<SparkToken, 'identifier' | 'ticker' | 'name' | 'decimals'>,
): SparkConvertAsset {
  return {
    id: token.identifier,
    ticker: token.ticker,
    name: token.name,
    decimals: token.decimals,
    fiatId: knownToken(token.identifier)?.fiatId,
  }
}

export const KNOWN_SPARK_TOKENS: SparkConvertAsset[] = DEFAULT_TOKENS.map(tokenToAsset)

// A listed token the wallet does not hold still appears, so it can be a conversion or receive target.
// `listed` is the wallet's catalog (defaults plus added); without it only the defaults are offered.
export function sparkConvertAssets(
  held: readonly SparkToken[],
  listed: readonly CatalogToken[] = DEFAULT_TOKENS,
): SparkConvertAsset[] {
  const assets: SparkConvertAsset[] = [SPARK_BTC]
  const seen = new Set<string>([BTC_ID])
  for (const asset of [...listed.map(tokenToAsset), ...held.map(tokenToAsset)]) {
    if (!seen.has(asset.id)) {
      seen.add(asset.id)
      assets.push(asset)
    }
  }
  // Bitcoin stays first; the tokens follow the one order every list uses.
  const [bitcoin, ...tokens] = assets
  return [bitcoin, ...tokens.sort((a, b) => byAssetOrder(a.id, b.id))]
}

export function tokenIdOf(asset: SparkConvertAsset): string | undefined {
  return asset.id === BTC_ID ? undefined : asset.id
}

// The asset a token identifier names, undefined being Bitcoin. Null for a token with no known decimals
// or ticker, whose base units can be drawn as nothing true.
export function assetOfToken(
  tokenIdentifier: string | undefined,
  known: readonly SparkConvertAsset[],
): SparkConvertAsset | null {
  if (tokenIdentifier === undefined) {
    return SPARK_BTC
  }
  const named = (asset: SparkConvertAsset) => asset.id === tokenIdentifier
  return known.find(named) ?? KNOWN_SPARK_TOKENS.find(named) ?? null
}

// BTC reuses the app's Bitcoin logo, which AssetIcon keys by BITCOIN_ASSET_ID.
export function iconIdOf(asset: SparkConvertAsset): string {
  return asset.id === BTC_ID ? BITCOIN_ASSET_ID : asset.id
}

// A display amount ("1.5", "4200") to the SDK's base units.
export function toBaseUnits(display: string, decimals: number): number {
  const value = Number(display)
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  return Math.round(value * 10 ** decimals)
}

// Exact, through strings and bigint. A double holds about 15 significant digits and USDC on BSC has 18
// decimals, so an amount a sender must match exactly never passes through a Number.
export function formatBaseUnitsExact(base: bigint, decimals: number): string {
  const digits = base.toString().padStart(decimals + 1, '0')
  const whole = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

// Null for anything that is not a positive amount the asset can represent, including more places
// than it has.
export function toBaseUnitsExact(display: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(display.trim())
  if (!match || (match[2] ?? '').length > decimals) {
    return null
  }
  const base = BigInt(match[1] + (match[2] ?? '').padEnd(decimals, '0'))
  return base > 0n ? base : null
}

// A non-negative amount brought to `places` places, up or down, and still in base units. Integers
// alone, since a double rounding an 18-place bound can land it on the wrong side of itself.
export function roundBaseUnits(
  base: bigint,
  decimals: number,
  places: number,
  direction: 'up' | 'down',
): bigint {
  if (places >= decimals) {
    return base
  }
  const step = 10n ** BigInt(decimals - places)
  const steps = direction === 'up' ? (base + step - 1n) / step : base / step
  return steps * step
}

// maxFraction caps the places shown. A double holds about 15 significant digits, so an 18-decimal
// amount prints float noise at full precision; capping belongs to display only, since rounding an
// amount about to be spent could round it above the balance.
export function fromBaseUnits(base: number, decimals: number, maxFraction = decimals): string {
  if (decimals <= 0) {
    return String(Math.round(base))
  }
  const s = (base / 10 ** decimals).toFixed(Math.min(decimals, maxFraction))
  return s.replace(/\.?0+$/, '')
}

// A quoted figure from the SDK's exact amount while that still is the figure, since a double drops
// a token's digits past about 15. A pair replaces a leg's figure, and the guard keeps the other
// leg's exact amount from being drawn in its place.
export function quotedFigure(base: number, exact: bigint | undefined, decimals: number): string {
  return exact !== undefined && Number(exact) === base
    ? formatBaseUnitsExact(exact, decimals)
    : fromBaseUnits(base, decimals)
}

// The BTC price in each fiat code, the shape sparkGetFiatRates returns.
export type BtcRates = Readonly<Record<string, number>>

// Rough two-sided display estimate through the fiat rates, never the executed price, which comes
// from sparkPrepareConvert on review. Null when a side cannot be priced, leaving the counter blank.
export function estimateSparkConvert(
  from: SparkConvertAsset,
  to: SparkConvertAsset,
  fromUnits: number,
  rates: BtcRates,
): number | null {
  const btc = toBtc(from, fromUnits, rates)
  if (btc === null || btc <= 0) {
    return null
  }
  return fromBtc(to, btc, rates)
}

// One unit of a token in another. Two places when it buys at least one, and otherwise enough places for
// two digits past the first significant one, so a small rate never reads 0.00.
export function formatPairRate(rate: number): string {
  if (!(rate > 0) || !Number.isFinite(rate)) {
    return '0'
  }
  if (rate >= 1) {
    return rate.toFixed(2)
  }
  const places = Math.min(8, Math.ceil(-Math.log10(rate)) + 2)
  return rate.toFixed(places).replace(/0+$/, '').replace(/\.$/, '')
}

// The allowed range at the fewest places from two that keep it in order: the minimum rounded up, so the
// figure shown always passes, and the maximum rounded down, so it never promises more than is held. Base
// units come back with the strings so the Min chip fills exactly what the line reads. A range already
// inverted (a balance under the minimum) is left exact for the caller to say so.
export function rangeBounds(
  minBase: number,
  maxBase: number,
  decimals: number,
): { minBase: number; maxBase: number; min: string; max: string } {
  const draw = (base: number, places: number) =>
    decimals <= 0 ? String(Math.round(base)) : (base / 10 ** decimals).toFixed(places)
  for (let places = Math.min(2, decimals); places <= decimals; places++) {
    const step = 10 ** (decimals - places)
    const lo = Math.ceil(minBase / step) * step
    const hi = Math.floor(maxBase / step) * step
    if (lo <= hi) {
      return { minBase: lo, maxBase: hi, min: draw(lo, places), max: draw(hi, places) }
    }
  }
  return { minBase, maxBase, min: draw(minBase, decimals), max: draw(maxBase, decimals) }
}

// The Flashnet AMM reports a zero fee and no spread field, so the real cost is derived from the two
// amounts against spot, and clamped at zero because that proxy can read a fair swap as negative.
export function effectiveConvertCostPct(
  from: SparkConvertAsset,
  to: SparkConvertAsset,
  spentBase: number,
  receivedBase: number,
  rates: BtcRates,
): number | null {
  const spent = toBtc(from, spentBase, rates)
  const received = toBtc(to, receivedBase, rates)
  if (spent === null || received === null || spent <= 0) {
    return null
  }
  return Math.max(0, ((spent - received) / spent) * 100)
}

// More precision under 1%, so a small cost keeps a real digit.
export function formatCostPct(pct: number): string {
  const rounded = pct < 1 ? Math.round(pct * 100) / 100 : Math.round(pct * 10) / 10
  return localizeAmount(String(rounded))
}

// Bitcoin is the common unit, so a pair prices through the rate of each side's own peg, USDB through
// the dollar and DePix through the real. An unpegged token, or a peg with no rate, is unpriceable.
function pegRate(asset: SparkConvertAsset, rates: BtcRates): number | null {
  const rate = asset.fiatId === undefined ? undefined : rates[asset.fiatId]
  return rate !== undefined && rate > 0 ? rate : null
}

function toBtc(asset: SparkConvertAsset, base: number, rates: BtcRates): number | null {
  if (asset.id === BTC_ID) {
    return base / 1e8
  }
  const rate = pegRate(asset, rates)
  return rate === null ? null : base / 10 ** asset.decimals / rate
}

function fromBtc(asset: SparkConvertAsset, btc: number, rates: BtcRates): number | null {
  if (asset.id === BTC_ID) {
    return Math.round(btc * 1e8)
  }
  const rate = pegRate(asset, rates)
  return rate === null ? null : Math.round(btc * rate * 10 ** asset.decimals)
}

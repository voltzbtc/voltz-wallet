import { formatSats } from './amount'
import { fiatFractionSize, fiatSymbol, formatFiat, formatFiatGeneric, localizeAmount, type FiatCurrency } from './fiat'
import { KNOWN_TOKENS, byAssetOrder } from './tokens'

// The Bitcoin row's display id. The value is the Liquid network's Bitcoin asset id, kept because the
// Home list, the converter and AssetIcon all key Bitcoin by it, not because anything Liquid remains.
export const BITCOIN_ASSET_ID = '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d'

// The fiat a known token tracks, which decides how its balance reads. Unknown tokens have none.
function pegOf(identifier: string): string | undefined {
  return KNOWN_TOKENS.find(known => known.identifier === identifier)?.fiatId
}

export type AssetRow = {
  assetId: string
  name: string
  ticker: string
  // Built with a dot and no grouping, like every amount in the model; screens localize it.
  amount: string
  // Removable only at zero balance, because held funds cannot be hidden.
  removable: boolean
}

// Integer base units to display units, by the asset's precision. String manipulation rather than
// float math or Intl (Hermes support varies).
export function formatAssetAmount(baseUnits: number, precision: number): string {
  if (precision <= 0) {
    return String(baseUnits)
  }
  const negative = baseUnits < 0
  const digits = Math.abs(baseUnits).toString().padStart(precision + 1, '0')
  const intPart = digits.slice(0, digits.length - precision)
  const frac = digits.slice(digits.length - precision).replace(/0+$/, '')
  const result = frac ? `${intPart}.${frac}` : intPart
  return negative ? `-${result}` : result
}

// Same rendering for an amount already in display units. toFixed keeps a very small value out of
// the scientific notation a bare String() would produce.
export function formatAssetDisplay(amount: number): string {
  if (!Number.isFinite(amount)) {
    return '0'
  }
  const fixed = Math.abs(amount).toFixed(8).replace(/\.?0+$/, '')
  const result = fixed === '' ? '0' : fixed
  return amount < 0 ? `-${result}` : result
}

// Home rows for a Spark wallet, starting with Bitcoin, then the tokens the wallet holds, then the
// catalog tokens at zero balance (USDB plus any added by hand) minus the hidden ones. A held
// row is never removable because a balance must stay visible, so `hidden` only ever suppresses a
// zero row. Tokens arrive as plain shapes to keep the Spark SDK out of this pure module, and
// catalog and hidden default to empty for callers that list held tokens only.
export function buildSparkAssetList(
  balanceSat: number,
  held: readonly {
    identifier: string
    name: string
    ticker: string
    decimals: number
    balanceBaseUnits: number
  }[],
  catalog: readonly { identifier: string; name: string; ticker: string; decimals: number; fiatId?: string }[] = [],
  hidden: readonly string[] = [],
): AssetRow[] {
  const rows: AssetRow[] = [
    { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin', ticker: 'sats', amount: String(balanceSat), removable: false },
  ]
  const heldIds = new Set(held.map(token => token.identifier))
  for (const token of held) {
    rows.push({
      assetId: token.identifier,
      name: token.name,
      ticker: token.ticker,
      amount: formatTokenBalance(token.balanceBaseUnits, token.decimals, pegOf(token.identifier)),
      removable: false,
    })
  }
  const hiddenIds = new Set(hidden)
  for (const token of catalog) {
    if (heldIds.has(token.identifier) || hiddenIds.has(token.identifier)) {
      continue
    }
    rows.push({
      assetId: token.identifier,
      name: token.name,
      ticker: token.ticker,
      amount: formatTokenBalance(0, token.decimals, pegOf(token.identifier)),
      removable: true,
    })
  }
  // Bitcoin stays first; the tokens follow the one order every list uses, held or not.
  const [bitcoin, ...tokens] = rows
  return [bitcoin, ...tokens.sort((a, b) => byAssetOrder(a.assetId, b.assetId))]
}

// The dollar wallet holds its value in the token, so that row leads and bitcoin follows. A zero
// bitcoin balance drops out entirely, since an empty row of the asset just left behind reads as
// clutter, while any remaining sats stay visible because held funds are never hidden.
export function orderForDollarMode(rows: AssetRow[], bitcoinSat: number): AssetRow[] {
  const bitcoin = rows.filter(row => row.assetId === BITCOIN_ASSET_ID)
  const rest = rows.filter(row => row.assetId !== BITCOIN_ASSET_ID)
  return bitcoinSat > 0 ? [...rest, ...bitcoin] : rest
}

// A list row's amount as drawn: sats the Bitcoin way, any other unit in the app language.
export function formatRowAmount(row: { ticker: string; amount: string }): string {
  return row.ticker === 'sats' ? formatSats(Number(row.amount)) : localizeAmount(row.amount)
}

// True for a pegged balance under one cent, which the list shows cut to its first digits and the
// asset's own screen shows in full. Decided on the base units, since two places would round half a
// cent up to 0.01.
export function isBelowCent(baseUnits: number, decimals: number): boolean {
  return baseUnits > 0 && baseUnits < 10 ** (decimals - 2)
}

// Dollars for an amount in sats, read at a rate that has the age of its read, so whoever draws this
// marks it approximate. Null with no rate, and under a cent, where the figure would round to nothing
// and the sats say more.
export function dollarsOfSats(sats: number, usdRate: number | undefined | null): number | null {
  if (usdRate === undefined || usdRate === null || !(usdRate > 0) || sats <= 0) {
    return null
  }
  const dollars = (sats / 1e8) * usdRate
  return isBelowCent(dollars * 100, 2) ? null : dollars
}

// A held balance shown the way its unit is normally read, so a dollar token lands on two decimals
// instead of the six the protocol stores. Under a cent it keeps its first two significant digits,
// cut rather than rounded, so a remainder reads neither as zero nor as more than is held. Only the
// reading changes; every amount that leaves the wallet keeps full precision.
export function formatTokenBalance(baseUnits: number, decimals: number, fiatId?: string): string {
  const exact = formatAssetAmount(baseUnits, decimals)
  if (fiatId === undefined || baseUnits === 0) {
    return exact
  }
  return isBelowCent(baseUnits, decimals)
    ? leadingDigits(exact, 2)
    : (baseUnits / 10 ** decimals).toFixed(2)
}

// A value in a currency, read as a balance under a cent is: below the smallest step the currency
// writes it keeps its first two significant digits, since the currency's own places would state a
// zero of a figure that is not one. Every place is cut rather than rounded, at or above the step as
// well, so a balance or a maximum never reads above itself: typed back as drawn, it would be refused.
//
// `atLeast` is for a minimum, which a cut would state below itself, for the same reason. The figure is
// then raised at its last place, at or above the step and under it alike.
export function formatSmallFiat(
  value: number,
  currency: FiatCurrency,
  { atLeast = false }: { atLeast?: boolean } = {},
): string {
  const places = fiatFractionSize(currency)
  if (!(value > 0)) {
    return formatFiat(value, currency)
  }
  if (value >= 10 ** -places) {
    return formatFiat(atLeast ? raisedAt(value, places) : cutAt(value, places), currency)
  }
  const exact = value.toFixed(12)
  if (!atLeast) {
    const cut = leadingDigits(exact, 2)
    return formatFiatGeneric(Number(cut), fiatSymbol(currency), cut.length - cut.indexOf('.') - 1)
  }
  const first = (exact.split('.')[1] ?? '').search(/[1-9]/)
  const significant = first < 0 ? 12 : first + 2
  const raised = raisedAt(value, significant)
  if (raised >= 10 ** -places) {
    return formatFiat(raised, currency)
  }
  const text = raised.toFixed(significant).replace(/0+$/, '')
  return formatFiatGeneric(raised, fiatSymbol(currency), text.length - text.indexOf('.') - 1)
}

// The value at `places` decimals, one step up when anything is left past them. Read on the text, since
// a float times a power of ten picks up a digit the value does not have (1.23 * 100 is 123.00000000000001).
function raisedAt(value: number, places: number): number {
  const [whole, fraction = ''] = value.toFixed(12).split('.')
  const kept = Number(`${whole}.${fraction.slice(0, places)}`)
  const scale = 10 ** places
  const over = /[1-9]/.test(fraction.slice(places)) ? 1 : 0
  return (Math.round(kept * scale) + over) / scale
}

// The value at `places` decimals with the rest dropped, read on the text for the same reason, so the
// formatter that follows has nothing left to round up.
function cutAt(value: number, places: number): number {
  const [whole, fraction = ''] = value.toFixed(12).split('.')
  return Number(`${whole}.${fraction.slice(0, places)}`)
}

// A token figure on a line of the history, at two places and never rounded up, so it cannot read as
// more than the wallet got. Works on the text, since a float would round before the cut. A figure
// under a hundredth keeps its digits, since the cut would state a zero nobody reported.
export function cutToTwoPlaces(exact: string): string {
  const [whole, fraction = ''] = exact.split('.')
  const cut = fraction.slice(0, 2).padEnd(2, '0')
  return /^0*$/.test(whole) && cut === '00' && /[1-9]/.test(fraction) ? exact : `${whole}.${cut}`
}

// A value under one, cut after its first `count` significant digits and without trailing zeros.
function leadingDigits(exact: string, count: number): string {
  const [intPart, frac = ''] = exact.split('.')
  const first = frac.search(/[1-9]/)
  return first < 0 ? exact : `${intPart}.${frac.slice(0, first + count)}`.replace(/0+$/, '')
}

// A read's rows in the order on screen, new ones last. Reordering persists nothing, so a load the
// person asked for rebuilds the order, and one they did not must not take it away.
export function inShownOrder(shown: AssetRow[], next: AssetRow[]): AssetRow[] {
  const place = new Map(shown.map((asset, index) => [asset.assetId, index]))
  const at = (asset: AssetRow): number => place.get(asset.assetId) ?? shown.length
  return [...next].sort((a, b) => at(a) - at(b))
}
